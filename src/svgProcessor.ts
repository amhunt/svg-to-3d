import { Color } from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import type { Shape, Vector2 } from "three";
import polygonClipping from "polygon-clipping";
import type { Pair, Ring, Polygon, MultiPolygon } from "polygon-clipping";

import {
  DEFAULT_PART_OPTIONS,
  MIN_AREA,
  bboxOfMultiPolygon,
  bboxesOverlap,
  buildColorMeshes,
  centerOnPlate,
  cleanPolygon,
  polysFromMultiPolygon,
  ringArea,
  type BBox,
  type CleanPoly,
  type ColorMesh,
  type PartOptions,
  type SolidPart,
  type Vec2,
} from "./solids.js";

export { DEFAULT_PART_OPTIONS };
export type { ColorMesh, PartOptions };

const CURVE_SEGMENTS = 24;

/** One painted element, in document order. */
export type SvgLayer = {
  color: string;
  shapes: Shape[];
};

/** What the SVG contained that no filament can print, so a UI can say so. */
export type SkippedContent = {
  /** Stroked paths — the outline itself is dropped (fills underneath stay). */
  strokes: number;
  /** `<text>` elements. Convert to outlines first. */
  text: number;
  /** Embedded `<image>` bitmaps. */
  images: number;
  /** Gradient fills, flattened to their first stop color. */
  gradients: number;
  /** Pattern fills, skipped. */
  patterns: number;
  /** Shapes hidden by display, visibility, zero opacity or a transparent fill. */
  hidden: number;
  /** `clip-path` attributes ignored (a clip to the whole canvas doesn't count). */
  clipPaths: number;
  /** `mask` attributes ignored. */
  masks: number;
  /** Colors painted with partial opacity; they print solid. */
  translucent: string[];
};

export type SvgDocumentInfo = {
  viewBox: { x: number; y: number; width: number; height: number } | null;
  /** The root's declared size, when it's in a physical unit (`width="50mm"`). */
  physicalSize: { width: number; height: number } | null;
  /** mm per user unit implied by `physicalSize`, or null when the SVG has no physical size. */
  mmPerUnit: number | null;
};

export type SvgAnalysis = {
  /** Canonical `#rrggbb` colors, in order of first appearance. */
  colors: string[];
  shapesByColor: Map<string, Shape[]>;
  /** Every painted element in document order — what `flatten` walks. */
  layers: SvgLayer[];
  skipped: SkippedContent;
  document: SvgDocumentInfo;
};

export type ProcessOptions = {
  /**
   * Resolve overlaps in painter's order so every point of the plane belongs
   * to exactly one color — the color that's visible there. Off, every color
   * is extruded over its full footprint and the parts intersect wherever the
   * art overlapped; slicers then let the later part cut into the earlier
   * ones, so a color painted on top of another disappears. On by default.
   */
  flatten?: boolean;
};

// ===========================================================================
// Colors
// ===========================================================================

type ParsedFill =
  | { kind: "color"; hex: string; alpha: number }
  | { kind: "none" }
  | { kind: "url"; id: string };

const FALLBACK_COLOR = "#808080";

function hexByte(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, "0");
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
}

/** CSS number or percentage → 0..1 alpha. */
function parseAlpha(s: string | undefined): number {
  if (s === undefined) return 1;
  const t = s.trim();
  if (t.endsWith("%")) return Math.max(0, Math.min(1, parseFloat(t) / 100));
  const n = parseFloat(t);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

/** CSS channel: number (0..255) or percentage. */
function parseChannel(s: string): number {
  const t = s.trim();
  if (t.endsWith("%")) return (parseFloat(t) / 100) * 255;
  return parseFloat(t);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
    return p;
  };
  return [
    channel(hue + 1 / 3) * 255,
    channel(hue) * 255,
    channel(hue - 1 / 3) * 255,
  ];
}

/**
 * Parse a CSS fill into a canonical `#rrggbb` plus alpha. Understands what
 * design tools actually emit: named colors, 3/4/6/8-digit hex, rgb()/rgba()
 * with numbers or percentages, hsl()/hsla(), `transparent`, `currentColor`
 * (resolved through `currentColor`) and `url(#id)` references.
 */
function parseFill(raw: string | undefined, currentColor: string): ParsedFill {
  if (raw === undefined || raw === null) {
    return { kind: "color", hex: "#000000", alpha: 1 };
  }
  const s = raw.trim().toLowerCase();
  if (s === "" || s === "none") return { kind: "none" };
  if (s === "transparent") return { kind: "color", hex: "#000000", alpha: 0 };
  if (s === "currentcolor") return parseFill(currentColor, "#000000");

  const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(s);
  if (url) return { kind: "url", id: url[1] };

  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split("").map((c) => parseInt(c + c, 16));
      return {
        kind: "color",
        hex: rgbToHex(r, g, b),
        alpha: h.length === 4 ? a / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        kind: "color",
        hex: `#${h.slice(0, 6)}`,
        alpha: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    return { kind: "color", hex: FALLBACK_COLOR, alpha: 1 };
  }

  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (fn) {
    const parts = fn[2]
      .replace(/\//g, " ")
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length < 3)
      return { kind: "color", hex: FALLBACK_COLOR, alpha: 1 };
    const alpha = parseAlpha(parts[3]);
    if (fn[1].startsWith("rgb")) {
      const [r, g, b] = parts.slice(0, 3).map(parseChannel);
      return { kind: "color", hex: rgbToHex(r, g, b), alpha };
    }
    const h = parseFloat(parts[0]);
    const sat = parseFloat(parts[1]) / 100;
    const light = parseFloat(parts[2]) / 100;
    const [r, g, b] = hslToRgb(h, sat, light);
    return { kind: "color", hex: rgbToHex(r, g, b), alpha };
  }

  const named = (Color.NAMES as Record<string, number>)[s];
  if (named !== undefined) {
    return {
      kind: "color",
      hex: `#${named.toString(16).padStart(6, "0")}`,
      alpha: 1,
    };
  }

  return { kind: "color", hex: FALLBACK_COLOR, alpha: 1 };
}

// ===========================================================================
// SVG pre-pass
//
// three's SVGLoader walks every element and only skips the children of
// <defs>. Anything else that isn't meant to render on its own — a <mask> or
// <clipPath> Figma leaves at the top level, a <symbol> waiting for a <use> —
// gets parsed as if it were artwork. It also never reads `display`, only
// looks for `xlink:href` on <use>, and hands url() fills back as white. The
// document is tidied here before the loader sees it.
// ===========================================================================

const DEFINITION_TAGS = new Set([
  "mask",
  "clippath",
  "pattern",
  "marker",
  "symbol",
  "lineargradient",
  "radialgradient",
  "filter",
]);

const XLINK = "http://www.w3.org/1999/xlink";

type Prepared = {
  text: string;
  skipped: SkippedContent;
  document: SvgDocumentInfo;
  /** Gradient id → first stop color; patterns and unknown ids are absent. */
  gradientColors: Map<string, string>;
};

/** Tag name without a namespace prefix, lower-cased (XML keeps `clipPath`'s case; some parsers don't). */
function localName(el: Element): string {
  return (el.localName ?? el.nodeName.replace(/^.*:/, "")).toLowerCase();
}

function styleProp(el: Element, prop: string): string | null {
  const attr = el.getAttribute(prop);
  const inline = el.getAttribute("style");
  if (inline) {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(
      inline,
    );
    if (m) return m[1].trim();
  }
  return attr;
}

function parseLength(
  raw: string | null,
): { value: number; unit: string } | null {
  if (!raw) return null;
  const m =
    /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(raw);
  if (!m) return null;
  return { value: parseFloat(m[1]), unit: m[2].toLowerCase() };
}

const MM_PER_UNIT: Record<string, number> = {
  mm: 1,
  cm: 10,
  q: 0.25,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
};

function documentInfo(root: Element): SvgDocumentInfo {
  let viewBox: SvgDocumentInfo["viewBox"] = null;
  const vb = root.getAttribute("viewBox");
  if (vb) {
    const n = vb
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0) {
      viewBox = { x: n[0], y: n[1], width: n[2], height: n[3] };
    }
  }

  const w = parseLength(root.getAttribute("width"));
  const h = parseLength(root.getAttribute("height"));
  let physicalSize: SvgDocumentInfo["physicalSize"] = null;
  if (w && h && MM_PER_UNIT[w.unit] && MM_PER_UNIT[h.unit]) {
    physicalSize = {
      width: w.value * MM_PER_UNIT[w.unit],
      height: h.value * MM_PER_UNIT[h.unit],
    };
  }

  let mmPerUnit: number | null = null;
  if (physicalSize) {
    // With a viewBox the user unit is a fraction of the declared width;
    // without one it's the CSS pixel.
    mmPerUnit = viewBox ? physicalSize.width / viewBox.width : 25.4 / 96;
  }

  return { viewBox, physicalSize, mmPerUnit };
}

/** A clip-path that just trims to the canvas (Figma frames) changes nothing. */
function clipCoversCanvas(clip: Element, info: SvgDocumentInfo): boolean {
  const kids = Array.from(clip.children).filter((c) => c.nodeType === 1);
  if (kids.length !== 1 || localName(kids[0]) !== "rect") return false;
  const rect = kids[0];
  if (rect.hasAttribute("transform") || clip.hasAttribute("transform")) {
    return false;
  }
  const vb = info.viewBox ?? { x: 0, y: 0, width: Infinity, height: Infinity };
  const x = parseFloat(rect.getAttribute("x") ?? "0");
  const y = parseFloat(rect.getAttribute("y") ?? "0");
  const w = parseFloat(rect.getAttribute("width") ?? "0");
  const h = parseFloat(rect.getAttribute("height") ?? "0");
  if (!Number.isFinite(vb.width)) return false;
  const eps = 1e-6;
  return (
    x <= vb.x + eps &&
    y <= vb.y + eps &&
    x + w >= vb.x + vb.width - eps &&
    y + h >= vb.y + vb.height - eps
  );
}

function firstStopColor(
  gradient: Element,
  byId: Map<string, Element>,
  seen = new Set<Element>(),
): string | null {
  if (seen.has(gradient)) return null;
  seen.add(gradient);
  const stops = Array.from(gradient.children).filter(
    (c) => localName(c) === "stop",
  );
  if (stops.length > 0) {
    const first = stops
      .map((s) => ({
        el: s,
        offset: parseFloat(s.getAttribute("offset") ?? "0") || 0,
      }))
      .sort((a, b) => a.offset - b.offset)[0].el;
    return styleProp(first, "stop-color") ?? "#000";
  }
  const href =
    gradient.getAttributeNS(XLINK, "href") ?? gradient.getAttribute("href");
  if (href?.startsWith("#")) {
    const parent = byId.get(href.slice(1));
    if (parent) return firstStopColor(parent, byId, seen);
  }
  return null;
}

function prepareSvg(svgText: string): Prepared {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.documentElement;
  if (
    !root ||
    localName(root) !== "svg" ||
    doc.getElementsByTagName("parsererror").length > 0
  ) {
    throw new Error("That file isn't an SVG, or the XML inside it is broken");
  }

  const skipped: SkippedContent = {
    strokes: 0,
    text: 0,
    images: 0,
    gradients: 0,
    patterns: 0,
    hidden: 0,
    clipPaths: 0,
    masks: 0,
    translucent: [],
  };
  const info = documentInfo(root);

  const all = Array.from(root.getElementsByTagName("*"));
  const byId = new Map<string, Element>();
  for (const el of all) {
    const id = el.getAttribute("id");
    if (id && !byId.has(id)) byId.set(id, el);
  }

  // Gradient stop colors, read before the gradients are tucked away.
  const gradientColors = new Map<string, string>();
  for (const el of all) {
    const name = localName(el);
    if (name === "lineargradient" || name === "radialgradient") {
      const id = el.getAttribute("id");
      const color = id ? firstStopColor(el, byId) : null;
      if (id && color) gradientColors.set(id, color);
    }
  }

  const inDefs = (el: Element): boolean => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (localName(p) === "defs") return true;
    }
    return false;
  };

  // 1. Hidden subtrees go entirely.
  for (const el of all) {
    if (!el.isConnected) continue;
    if (styleProp(el, "display")?.trim().toLowerCase() === "none") {
      skipped.hidden++;
      el.remove();
    }
  }

  // 2. Count the content that has no 3D meaning.
  for (const el of all) {
    if (!el.isConnected) continue;
    const name = localName(el);
    if (name === "text") skipped.text++;
    else if (name === "image") skipped.images++;
    if (styleProp(el, "mask")) skipped.masks++;
    const clip = styleProp(el, "clip-path");
    if (clip) {
      const m = /url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(clip);
      const target = m ? byId.get(m[1]) : undefined;
      if (!target || !clipCoversCanvas(target, info)) skipped.clipPaths++;
    }
    // SVG 2 dropped the xlink prefix; the loader still wants it.
    if (name === "use" && !el.hasAttributeNS(XLINK, "href")) {
      const href = el.getAttribute("href");
      if (href) {
        if (!root.hasAttribute("xmlns:xlink")) {
          root.setAttributeNS(
            "http://www.w3.org/2000/xmlns/",
            "xmlns:xlink",
            XLINK,
          );
        }
        el.setAttributeNS(XLINK, "xlink:href", href);
      }
    }
  }

  // 3. Quarantine definitions that sit outside <defs>, where the loader
  //    would draw them. Moving (not deleting) keeps <use> references alive.
  let defs: Element | null = null;
  for (const el of all) {
    if (!el.isConnected) continue;
    if (!DEFINITION_TAGS.has(localName(el)) || inDefs(el)) continue;
    if (!defs) {
      defs = doc.createElementNS("http://www.w3.org/2000/svg", "defs");
      root.insertBefore(defs, root.firstChild);
    }
    defs.appendChild(el);
  }

  const text = new XMLSerializer().serializeToString(doc);
  return { text, skipped, document: info, gradientColors };
}

/** Nearest `color` property up the tree, for `currentColor` fills. */
function currentColorOf(node: Element | undefined): string {
  for (let el: Element | null = node ?? null; el; el = el.parentElement) {
    const c = styleProp(el, "color");
    if (c) return c;
  }
  return "#000000";
}

type PathStyle = {
  fill?: string;
  fillOpacity?: number;
  opacity?: number;
  stroke?: string;
  strokeWidth?: number;
  visibility?: string;
};

/**
 * Parse an SVG and group its filled shapes by color. Cheap — no geometry.
 * Throws when the text isn't an SVG at all.
 */
export function analyzeSvg(svgText: string): SvgAnalysis {
  const prepared = prepareSvg(svgText);
  const loader = new SVGLoader();
  const data = loader.parse(prepared.text);
  const { skipped } = prepared;

  const shapesByColor = new Map<string, Shape[]>();
  const layers: SvgLayer[] = [];
  const translucent = new Set<string>();

  for (const path of data.paths) {
    const userData = path.userData as
      { style?: PathStyle; node?: Element } | undefined;
    const style = userData?.style ?? {};

    if (
      style.stroke !== undefined &&
      style.stroke !== "none" &&
      (style.strokeWidth ?? 1) > 0
    ) {
      skipped.strokes++;
    }

    const visibility = style.visibility?.trim().toLowerCase();
    if (visibility === "hidden" || visibility === "collapse") {
      skipped.hidden++;
      continue;
    }

    let fill = parseFill(style.fill, currentColorOf(userData?.node));
    if (fill.kind === "url") {
      const stop = prepared.gradientColors.get(fill.id);
      if (stop === undefined) {
        skipped.patterns++;
        continue;
      }
      skipped.gradients++;
      fill = parseFill(stop, "#000000");
    }
    if (fill.kind !== "color") continue;

    const alpha = fill.alpha * (style.fillOpacity ?? 1) * (style.opacity ?? 1);
    if (alpha <= 0) {
      skipped.hidden++;
      continue;
    }
    if (alpha < 1) translucent.add(fill.hex);

    // toShapes() carries the even-odd hole detection; SVGLoader.createShapes
    // is a deprecated wrapper around it as of three r185.
    const shapes = path.toShapes();
    if (shapes.length === 0) continue;

    const color = fill.hex;
    const list = shapesByColor.get(color) ?? [];
    list.push(...shapes);
    shapesByColor.set(color, list);
    layers.push({ color, shapes });
  }

  skipped.translucent = Array.from(translucent);

  return {
    colors: Array.from(shapesByColor.keys()),
    shapesByColor,
    layers,
    skipped,
    document: prepared.document,
  };
}

// ===========================================================================
// Shapes → polygons
// ===========================================================================

function toLocal(pts: Vector2[], scale: number): Vec2[] {
  // SVG +Y (down the page) becomes +Z. Y up, X × Z pointing down, so the
  // art reads correctly from above; the exporter turns this into Z up.
  return pts.map((p) => ({ x: p.x * scale, y: p.y * scale }));
}

function toRing(pts: Vec2[]): Ring {
  return pts.map((p) => [p.x, p.y] as Pair);
}

/** Each shape as its own polygon-clipping MultiPolygon, cleaned and scaled. */
function shapesToGeoms(
  shapes: Shape[],
  scale: number,
  eps: number,
): MultiPolygon[] {
  const geoms: MultiPolygon[] = [];
  for (const shape of shapes) {
    const ex = shape.extractPoints(CURVE_SEGMENTS);
    const outline = cleanPolygon(toLocal(ex.shape, scale), eps);
    if (outline.length < 3) continue;
    const holes = (ex.holes ?? [])
      .map((h) => cleanPolygon(toLocal(h, scale), eps))
      .filter((h) => h.length >= 3);
    geoms.push([[toRing(outline), ...holes.map(toRing)]]);
  }
  return geoms;
}

function unionAll(geoms: MultiPolygon[]): MultiPolygon {
  if (geoms.length === 1) return geoms[0];
  return polygonClipping.union(geoms[0], ...geoms.slice(1));
}

/**
 * Resolve all shapes of one color into clean, non-overlapping polygons.
 *
 * Stained-glass-style SVGs have many cells of the same color that touch or
 * overlap; individual shapes may also be self-intersecting. Welding such
 * geometry produces edges shared by more than two triangles. Running a boolean
 * union over all of a color's shapes merges touching cells, removes
 * self-intersections, and yields a proper set of outlines + holes.
 */
function unionColorPolygons(
  shapes: Shape[],
  scale: number,
  eps: number,
): CleanPoly[] {
  const geoms = shapesToGeoms(shapes, scale, eps);
  if (geoms.length === 0) return [];
  try {
    return polysFromMultiPolygon(unionAll(geoms), eps);
  } catch {
    // If the boolean op fails, fall back to the raw (cleaned) shapes.
    return polysFromMultiPolygon(
      geoms.map((g) => g[0]),
      eps,
    );
  }
}

/**
 * Painter's-order flatten. Walk the layers from the top of the stack down;
 * each run of same-colored layers keeps only what nothing above it covers.
 * Every point of the art then belongs to exactly one color — the one you
 * see — so black pupils painted over white eyes over a black head come out
 * as pupils, and the parts never intersect in 3D.
 *
 * Only the raw pieces above with an overlapping bounding box take part in
 * each difference, which keeps dense art (thousands of small cells) fast.
 */
function flattenLayers(
  layers: SvgLayer[],
  scale: number,
  eps: number,
): Map<string, CleanPoly[]> {
  const runs: SvgLayer[] = [];
  for (const layer of layers) {
    const last = runs[runs.length - 1];
    if (last && last.color === layer.color) last.shapes.push(...layer.shapes);
    else runs.push({ color: layer.color, shapes: [...layer.shapes] });
  }

  const above: { bbox: BBox; mp: MultiPolygon }[] = [];
  const visibleByColor = new Map<string, Polygon[]>();

  for (let i = runs.length - 1; i >= 0; i--) {
    const geoms = shapesToGeoms(runs[i].shapes, scale, eps);
    if (geoms.length === 0) continue;

    let piece: MultiPolygon;
    try {
      piece = unionAll(geoms);
    } catch {
      piece = geoms.map((g) => g[0]);
    }
    const bbox = bboxOfMultiPolygon(piece);

    const hits = above
      .filter((o) => bboxesOverlap(o.bbox, bbox))
      .map((o) => o.mp);
    let visible: MultiPolygon;
    try {
      visible = hits.length
        ? polygonClipping.difference(piece, ...hits)
        : piece;
    } catch {
      visible = piece;
    }
    above.push({ bbox, mp: piece });

    const kept = visible.filter((poly) => {
      const area =
        ringArea(poly[0]) -
        poly.slice(1).reduce((sum, r) => sum + ringArea(r), 0);
      return area >= MIN_AREA;
    });
    if (kept.length === 0) continue;
    const list = visibleByColor.get(runs[i].color) ?? [];
    list.push(...kept);
    visibleByColor.set(runs[i].color, list);
  }

  const result = new Map<string, CleanPoly[]>();
  for (const [color, polys] of Array.from(visibleByColor)) {
    let merged: MultiPolygon;
    try {
      merged = unionAll(polys.map((p) => [p]));
    } catch {
      merged = polys;
    }
    result.set(color, polysFromMultiPolygon(merged, eps));
  }
  return result;
}

// ===========================================================================
// Public API
// ===========================================================================

/** Build the per-color 3D meshes from a parsed SVG plus per-part settings. */
export function processAnalysis(
  analysis: SvgAnalysis,
  scale: number,
  optionsByColor: Map<string, PartOptions>,
  options: ProcessOptions = {},
): ColorMesh[] {
  const flatten = options.flatten ?? true;
  // Cleanup epsilon in mm, well below FDM print resolution.
  const eps = 1e-3;

  // 1. Every color's footprint as clean polygons.
  const polysByColor = new Map<string, CleanPoly[]>();
  if (flatten && analysis.layers) {
    const flat = flattenLayers(analysis.layers, scale, eps);
    for (const color of Array.from(analysis.shapesByColor.keys())) {
      polysByColor.set(color, flat.get(color) ?? []);
    }
  } else {
    for (const [color, shapes] of Array.from(analysis.shapesByColor)) {
      polysByColor.set(color, unionColorPolygons(shapes, scale, eps));
    }
  }

  const parts: SolidPart[] = Array.from(polysByColor, ([color, polys]) => ({
    color,
    polys,
    options: optionsByColor.get(color) ?? DEFAULT_PART_OPTIONS,
  }));
  return centerOnPlate(buildColorMeshes(parts));
}
