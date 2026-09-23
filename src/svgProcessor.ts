import { Color } from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import type { Shape, Vector2 } from "three";
import earcut from "earcut";
import polygonClipping from "polygon-clipping";
import type { Pair, Ring, Polygon, MultiPolygon } from "polygon-clipping";

const CURVE_SEGMENTS = 24;

export type ColorMesh = {
  /** Canonical `#rrggbb` fill color this part was built from. */
  color: string;
  /** xyz triples. Y is up, the art lies in XZ, the base rests at y = 0. */
  vertices: Float32Array;
  triangles: Uint32Array;
  /**
   * Edges not shared by exactly two consistently-wound triangles. A closed,
   * outward-facing solid reports 0.
   */
  nonManifoldEdges: number;
  /**
   * Polygons whose chamfer self-intersected and were extruded straight
   * instead (bevels don't fit on features narrower than the bevel).
   */
  bevelFallbacks: number;
};

/** Per-part (or per-object) settings, keyed by SVG fill color. */
export type PartOptions = {
  extrudeDepth: number; // mm
  bevelTop: boolean;
  bevelBottom: boolean;
  bevelSize: number; // mm — how far the edge is inset horizontally
  bevelThickness: number; // mm — vertical height of the chamfer
};

export const DEFAULT_PART_OPTIONS: PartOptions = {
  extrudeDepth: 2,
  bevelTop: false,
  bevelBottom: false,
  bevelSize: 0.6,
  bevelThickness: 0.6,
};

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
// 2D polygon helpers
// ===========================================================================

type Vec2 = { x: number; y: number };
type CleanPoly = { outline: Vec2[]; holes: Vec2[][] };
type BBox = { minX: number; minY: number; maxX: number; maxY: number };

function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}

function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function ensureWinding(pts: Vec2[], wantCCW: boolean): Vec2[] {
  const isCCW = signedArea(pts) > 0;
  return isCCW === wantCCW ? pts : pts.slice().reverse();
}

function bboxOf(pts: Vec2[]): BBox {
  const b = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  for (const p of pts) {
    if (p.x < b.minX) b.minX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y > b.maxY) b.maxY = p.y;
  }
  return b;
}

function bboxOfMultiPolygon(mp: MultiPolygon): BBox {
  const b = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  for (const poly of mp) {
    for (const [x, y] of poly[0]) {
      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;
    }
  }
  return b;
}

function bboxesOverlap(a: BBox, b: BBox): boolean {
  return (
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY
  );
}

function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPoly(p: Vec2, poly: CleanPoly): boolean {
  if (!pointInRing(p, poly.outline)) return false;
  for (const h of poly.holes) if (pointInRing(p, h)) return false;
  return true;
}

/**
 * Path cleanup. SVG exporters frequently emit duplicate/near-coincident
 * points, zero-length segments, and redundant collinear points. Feeding those
 * into triangulation produces degenerate (zero-area) triangles, which become
 * non-manifold edges after welding. Removing them up front makes the outline a
 * clean simple polygon.
 */
function cleanPolygon(pts: Vec2[], eps: number): Vec2[] {
  // 1. Drop consecutive duplicates.
  let out: Vec2[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > eps) out.push(p);
  }
  // 2. Drop a closing point that duplicates the first.
  while (
    out.length > 1 &&
    Math.hypot(
      out[0].x - out[out.length - 1].x,
      out[0].y - out[out.length - 1].y,
    ) <= eps
  ) {
    out.pop();
  }
  // 3. Drop collinear points and spikes (a vertex whose two edges are
  //    parallel — it contributes nothing but a degenerate triangle).
  if (out.length > 3) {
    const filtered: Vec2[] = [];
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const prev = out[(i - 1 + n) % n];
      const curr = out[i];
      const next = out[(i + 1) % n];
      const cross =
        (curr.x - prev.x) * (next.y - curr.y) -
        (curr.y - prev.y) * (next.x - curr.x);
      const len1 = Math.hypot(curr.x - prev.x, curr.y - prev.y);
      const len2 = Math.hypot(next.x - curr.x, next.y - curr.y);
      if (Math.abs(cross) > eps * Math.max(len1, len2)) filtered.push(curr);
    }
    if (filtered.length >= 3) out = filtered;
  }
  return out;
}

/**
 * Offset a polygon's edges into the solid. `distance > 0` always reduces the
 * solid area: a CCW outline shrinks inward, a CW hole grows outward. With
 * `edges`, only the flagged edges move (edge `i` runs from point `i` to
 * point `i + 1`); the others stay put and the shared vertices slide along
 * them.
 *
 * Rings arrive consistently wound — outlines CCW, holes CW — so the solid
 * is always on the left of the direction of travel, for both.
 */
function insetPolygon(
  pts: Vec2[],
  distance: number,
  edges?: boolean[],
): Vec2[] {
  const n = pts.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];

    const d1 = (edges?.[(i - 1 + n) % n] ?? true) ? distance : 0;
    const d2 = (edges?.[i] ?? true) ? distance : 0;
    if (d1 === 0 && d2 === 0) {
      out.push({ x: curr.x, y: curr.y });
      continue;
    }

    let e1x = curr.x - prev.x;
    let e1y = curr.y - prev.y;
    const l1 = Math.hypot(e1x, e1y) || 1;
    e1x /= l1;
    e1y /= l1;

    let e2x = next.x - curr.x;
    let e2y = next.y - curr.y;
    const l2 = Math.hypot(e2x, e2y) || 1;
    e2x /= l2;
    e2y /= l2;

    // Toward the solid: the edge direction rotated +90°.
    const n1x = -e1y;
    const n1y = e1x;
    const n2x = -e2y;
    const n2y = e2x;

    // The new vertex sits `d1` off the incoming edge and `d2` off the
    // outgoing one: the intersection of the two offset lines.
    let vx: number;
    let vy: number;
    const det = n1x * n2y - n1y * n2x;
    if (Math.abs(det) < 1e-9) {
      // Parallel edges: just step off whichever one is moving.
      const d = Math.max(d1, d2);
      vx = (d1 >= d2 ? n1x : n2x) * d;
      vy = (d1 >= d2 ? n1y : n2y) * d;
    } else {
      vx = (d1 * n2y - d2 * n1y) / det;
      vy = (n1x * d2 - n2x * d1) / det;
    }

    // Clamp to keep sharp corners from shooting off into long spikes.
    const maxLen = 5 * Math.max(d1, d2);
    const len = Math.hypot(vx, vy);
    if (len > maxLen) {
      vx *= maxLen / len;
      vy *= maxLen / len;
    }

    out.push({ x: curr.x + vx, y: curr.y + vy });
  }
  return out;
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

/** Erode every polygon by a sub-micron amount. A boolean union leaves regions
 * that touch at a single point still joined there; in 3D that pinch is a
 * non-manifold edge. Shrinking the solid by ~0.5µm opens those pinches into
 * separate, individually watertight solids without any visible change (a 1µm
 * gap is ~800× finer than a typical print nozzle). */
const ERODE = 5e-4;

/** Anything smaller than this (mm²) is a boolean-op sliver, not artwork. */
const MIN_AREA = 1e-4;

function fromRings(poly: Polygon, eps: number): CleanPoly | null {
  let outline = ensureWinding(
    cleanPolygon(
      poly[0].map(([x, y]) => ({ x, y })),
      eps,
    ),
    true,
  );
  if (outline.length < 3) return null;
  let holes = poly
    .slice(1)
    .map((r) =>
      ensureWinding(
        cleanPolygon(
          r.map(([x, y]) => ({ x, y })),
          eps,
        ),
        false,
      ),
    )
    .filter((h) => h.length >= 3);

  outline = cleanPolygon(insetPolygon(outline, ERODE), eps);
  // A sliver thinner than the erosion turns inside out when inset; its walls
  // would then face inward while the caps still face out. Drop it.
  if (outline.length < 3 || signedArea(outline) <= 0) return null;
  holes = holes
    .map((h) => cleanPolygon(insetPolygon(h, ERODE), eps))
    .filter((h) => h.length >= 3 && signedArea(h) < 0);

  return { outline, holes };
}

/** Clean, erode and wind every polygon of a MultiPolygon. */
function polysFromMultiPolygon(mp: MultiPolygon, eps: number): CleanPoly[] {
  const result: CleanPoly[] = [];
  for (const poly of mp) {
    const cp = fromRings(poly, eps);
    if (cp) result.push(cp);
  }
  return result;
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
// Mesh construction
//
// Geometry is built directly in the final coordinate space: the SVG lies flat
// on the XZ build plate, extrusion goes up (+Y). A point (lx, ly) in cleaned
// local 2D maps to world (lx, height, ly). Building the caps and walls from
// the same outline points means the mesh is watertight by construction.
// ===========================================================================

type Builder = {
  positions: number[];
  indices: number[];
};

function pushVert(b: Builder, x: number, y: number, z: number): number {
  const i = b.positions.length / 3;
  b.positions.push(x, y, z);
  return i;
}

/** Triangulate a polygon-with-holes into a horizontal cap at height `y`. */
function addCap(
  b: Builder,
  outline: Vec2[],
  holes: Vec2[][],
  y: number,
  faceUp: boolean,
): void {
  const baseIdx = b.positions.length / 3;
  for (const p of outline) pushVert(b, p.x, y, p.y);
  for (const h of holes) for (const p of h) pushVert(b, p.x, y, p.y);

  // Flatten into the layout Earcut expects: a single coordinate array plus the
  // starting vertex index of each hole. Earcut is robust with many holes,
  // including holes that touch — ShapeUtils.triangulateShape is not.
  const flat: number[] = [];
  for (const p of outline) flat.push(p.x, p.y);
  const holeIndices: number[] = [];
  for (const h of holes) {
    holeIndices.push(flat.length / 2);
    for (const p of h) flat.push(p.x, p.y);
  }

  const idx = earcut(flat, holeIndices, 2);
  // Local (x, y) lands in world (x, z), and X × Z points down: a CCW outline
  // yields -Y-facing triangles. Reverse them for the top cap.
  for (let i = 0; i < idx.length; i += 3) {
    const a = baseIdx + idx[i];
    const c = baseIdx + idx[i + 1];
    const d = baseIdx + idx[i + 2];
    if (faceUp) b.indices.push(a, d, c);
    else b.indices.push(a, c, d);
  }
}

/**
 * Build a wall band between a `lower` ring at `yLower` and an `upper` ring at
 * `yUpper`. The rings must have matching point counts. Used for straight side
 * walls (lower === upper) and for the bevel chamfers (one ring is inset).
 */
function addBand(
  b: Builder,
  lower: Vec2[],
  upper: Vec2[],
  yLower: number,
  yUpper: number,
): void {
  const n = lower.length;
  if (n < 3 || upper.length !== n) return;

  const firstLower = b.positions.length / 3;
  for (const p of lower) pushVert(b, p.x, yLower, p.y);
  const firstUpper = b.positions.length / 3;
  for (const p of upper) pushVert(b, p.x, yUpper, p.y);

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const li = firstLower + i;
    const lj = firstLower + j;
    const ui = firstUpper + i;
    const uj = firstUpper + j;
    // Split the quad along a diagonal chosen deterministically from the
    // segment's world coordinates (not traversal order). When two regions
    // share this edge, both pick the SAME diagonal, so their walls become
    // coincident triangles that dissolveInternalWalls can fuse away.
    const pi = lower[i];
    const pj = lower[j];
    const iFirst = pi.x < pj.x || (pi.x === pj.x && pi.y < pj.y);
    if (iFirst) {
      b.indices.push(li, uj, lj, li, ui, uj);
    } else {
      b.indices.push(li, ui, lj, ui, uj, lj);
    }
  }
}

/** Which edges of a polygon may be chamfered: the top ones and the bottom ones. */
type BevelEdges = {
  top: { outline: boolean[]; holes: boolean[][] } | null;
  bottom: { outline: boolean[]; holes: boolean[][] } | null;
};

/** Build the extruded solid for a single polygon (outline + holes). */
function buildPolyGeometry(
  poly: CleanPoly,
  opts: PartOptions,
  edges: BevelEdges,
): { vertices: number[]; triangles: number[] } {
  const b: Builder = { positions: [], indices: [] };
  const { outline, holes } = poly;

  const depth = Math.max(opts.extrudeDepth, 0.01);
  const hasBevel = opts.bevelSize > 0 && opts.bevelThickness > 0;
  const topBevel = opts.bevelTop && hasBevel && edges.top !== null;
  const botBevel = opts.bevelBottom && hasBevel && edges.bottom !== null;

  // Vertical height consumed by each chamfer. Scale both down if together
  // they'd leave no straight wall.
  let topT = topBevel ? opts.bevelThickness : 0;
  let botT = botBevel ? opts.bevelThickness : 0;
  if (topT + botT > depth * 0.9 && topT + botT > 0) {
    const k = (depth * 0.9) / (topT + botT);
    topT *= k;
    botT *= k;
  }
  const baseLow = botT;
  const baseHigh = depth - topT;

  const topOutline = topBevel
    ? insetPolygon(outline, opts.bevelSize, edges.top?.outline)
    : outline;
  const topHoles = topBevel
    ? holes.map((h, i) => insetPolygon(h, opts.bevelSize, edges.top?.holes[i]))
    : holes;
  const botOutline = botBevel
    ? insetPolygon(outline, opts.bevelSize, edges.bottom?.outline)
    : outline;
  const botHoles = botBevel
    ? holes.map((h, i) =>
        insetPolygon(h, opts.bevelSize, edges.bottom?.holes[i]),
      )
    : holes;

  // Bottom cap (faces down toward the build plate).
  addCap(b, botOutline, botHoles, 0, false);

  // Bottom chamfer: inset cap edge (y=0) out to the full outline (y=baseLow).
  if (botBevel) {
    addBand(b, botOutline, outline, 0, baseLow);
    for (let i = 0; i < holes.length; i++) {
      addBand(b, botHoles[i], holes[i], 0, baseLow);
    }
  }

  // Straight side walls.
  addBand(b, outline, outline, baseLow, baseHigh);
  for (const h of holes) addBand(b, h, h, baseLow, baseHigh);

  // Top chamfer: full outline (y=baseHigh) in to the inset cap edge (y=depth).
  if (topBevel) {
    addBand(b, outline, topOutline, baseHigh, depth);
    for (let i = 0; i < holes.length; i++) {
      addBand(b, holes[i], topHoles[i], baseHigh, depth);
    }
  }

  // Top cap (faces up).
  addCap(b, topOutline, topHoles, depth, true);

  return { vertices: b.positions, triangles: b.indices };
}

/**
 * Build, weld and repair one polygon's solid. If beveling produces a
 * non-manifold result (the inset can self-intersect on features smaller than
 * the bevel), fall back to a straight, un-beveled extrusion for that polygon.
 */
function buildManifoldPoly(
  poly: CleanPoly,
  opts: PartOptions,
  edges: BevelEdges,
): { vertices: Float32Array; triangles: Uint32Array; bevelFallback: boolean } {
  const finish = (o: PartOptions) => {
    const raw = buildPolyGeometry(poly, o, edges);
    const welded = weldAndClean(raw.vertices, raw.triangles);
    const dissolved = dissolveInternalWalls(welded.triangles);
    const triangles = repairTJunctions(welded.vertices, dissolved);
    return { vertices: welded.vertices, triangles };
  };

  const beveled = finish(opts);
  const wantsBevel =
    (opts.bevelTop && edges.top !== null) ||
    (opts.bevelBottom && edges.bottom !== null);
  if (wantsBevel && countNonManifoldEdges(beveled.triangles) > 0) {
    return {
      ...finish({ ...opts, bevelTop: false, bevelBottom: false }),
      bevelFallback: true,
    };
  }
  return { ...beveled, bevelFallback: false };
}

// ===========================================================================
// Bevel exposure
//
// A chamfer belongs on an edge with air beside it. Where a color meets
// another color at the same height — every seam once the art is flattened —
// a chamfer on either side would open a V-groove between them. So each edge
// is probed just outside the polygon: if a neighbouring color is there and
// stands tall enough to fill the chamfer band, that edge keeps its square
// corner.
// ===========================================================================

type Neighbour = { poly: CleanPoly; bbox: BBox; top: number };

/** How far outside an edge to look for a neighbour (mm). */
const PROBE = 0.02;

function exposedEdges(
  ring: Vec2[],
  neighbours: Neighbour[],
  /** A neighbour has to reach above this height to cover the chamfer. */
  minTop: number,
): boolean[] {
  const n = ring.length;
  const out: boolean[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    let ex = b.x - a.x;
    let ey = b.y - a.y;
    const len = Math.hypot(ex, ey) || 1;
    ex /= len;
    ey /= len;
    // Away from the solid: the edge direction rotated -90° (the solid is on
    // the left of every ring, outline or hole).
    const p = {
      x: (a.x + b.x) / 2 + ey * PROBE,
      y: (a.y + b.y) / 2 - ex * PROBE,
    };
    let covered = false;
    for (const nb of neighbours) {
      if (nb.top <= minTop) continue;
      const bb = nb.bbox;
      if (p.x < bb.minX || p.x > bb.maxX || p.y < bb.minY || p.y > bb.maxY) {
        continue;
      }
      if (pointInPoly(p, nb.poly)) {
        covered = true;
        break;
      }
    }
    out[i] = !covered;
  }
  return out;
}

function bevelEdges(
  poly: CleanPoly,
  opts: PartOptions,
  neighbours: Neighbour[],
): BevelEdges {
  const hasBevel = opts.bevelSize > 0 && opts.bevelThickness > 0;
  const depth = Math.max(opts.extrudeDepth, 0.01);
  const pick = (
    wanted: boolean,
    minTop: number,
  ): { outline: boolean[]; holes: boolean[][] } | null => {
    if (!wanted || !hasBevel) return null;
    const bbox = bboxOf(poly.outline);
    const near = neighbours.filter(
      (nb) =>
        nb.top > minTop &&
        bboxesOverlap(
          {
            minX: bbox.minX - PROBE,
            minY: bbox.minY - PROBE,
            maxX: bbox.maxX + PROBE,
            maxY: bbox.maxY + PROBE,
          },
          nb.bbox,
        ),
    );
    const edges = {
      outline: exposedEdges(poly.outline, near, minTop),
      holes: poly.holes.map((h) => exposedEdges(h, near, minTop)),
    };
    const any =
      edges.outline.some(Boolean) || edges.holes.some((h) => h.some(Boolean));
    return any ? edges : null;
  };
  return {
    // The top chamfer occupies the band just under the cap; a neighbour
    // that stops below it leaves the edge in the open.
    top: pick(opts.bevelTop, depth - opts.bevelThickness + 1e-6),
    // Every part starts on the plate, so any neighbour covers the bottom.
    bottom: pick(opts.bevelBottom, 0),
  };
}

// ===========================================================================
// Welding & manifold validation
// ===========================================================================

/**
 * Weld coincident vertices so adjacent triangles share indices (required for
 * 3MF's index-based manifold check) and drop triangles that collapse to a
 * degenerate after welding.
 */
function weldAndClean(
  vertices: number[],
  triangles: number[],
): { vertices: Float32Array; triangles: Uint32Array } {
  const Q = 1e4; // quantize to 1e-4 mm
  const map = new Map<string, number>();
  const newVerts: number[] = [];
  const remap = new Uint32Array(vertices.length / 3);

  for (let i = 0; i < vertices.length; i += 3) {
    const x = Math.round(vertices[i] * Q) / Q;
    const y = Math.round(vertices[i + 1] * Q) / Q;
    const z = Math.round(vertices[i + 2] * Q) / Q;
    const key = `${x},${y},${z}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = newVerts.length / 3;
      newVerts.push(x, y, z);
      map.set(key, idx);
    }
    remap[i / 3] = idx;
  }

  const kept: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const a = remap[triangles[i]];
    const b = remap[triangles[i + 1]];
    const c = remap[triangles[i + 2]];
    if (a !== b && b !== c && a !== c) kept.push(a, b, c);
  }

  return {
    vertices: new Float32Array(newVerts),
    triangles: new Uint32Array(kept),
  };
}

/**
 * Dissolve internal walls. When two same-color regions touch along an edge,
 * each extrudes its own wall there; the two walls are coincident triangles
 * with opposite winding, leaving every shared edge bordered by 4 triangles.
 * A genuine manifold surface never has two triangles on the same 3 vertices,
 * so we can safely drop coincident triangles in pairs — which fuses the
 * touching regions into one solid.
 */
function dissolveInternalWalls(triangles: Uint32Array): Uint32Array {
  const keyOf = (a: number, b: number, c: number): string => {
    const s = [a, b, c].sort((x, y) => x - y);
    return `${s[0]}_${s[1]}_${s[2]}`;
  };

  const total = new Map<string, number>();
  for (let i = 0; i < triangles.length; i += 3) {
    const k = keyOf(triangles[i], triangles[i + 1], triangles[i + 2]);
    total.set(k, (total.get(k) ?? 0) + 1);
  }

  const kept: number[] = [];
  const used = new Map<string, number>();
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i];
    const b = triangles[i + 1];
    const c = triangles[i + 2];
    const k = keyOf(a, b, c);
    const keep = (total.get(k) ?? 0) % 2; // even count → all internal, drop
    const u = used.get(k) ?? 0;
    if (u < keep) {
      kept.push(a, b, c);
      used.set(k, u + 1);
    }
  }
  return new Uint32Array(kept);
}

/**
 * Repair T-junctions. Where two regions meet, one side's boundary edge can
 * span several vertices that belong to the other side's rings — the cap has
 * one long edge while the adjoining geometry is subdivided, leaving the long
 * edge bordered by a single triangle. We split such triangles so the long
 * edge is subdivided at every vertex that lies on it.
 */
function repairTJunctions(
  vertices: Float32Array,
  triangles: Uint32Array,
): Uint32Array {
  const vc = vertices.length / 3;
  let tris: number[] = Array.from(triangles);

  for (let pass = 0; pass < 12; pass++) {
    const edgeMap = new Map<string, number[]>();
    for (let t = 0; t < tris.length; t += 3) {
      const v = [tris[t], tris[t + 1], tris[t + 2]];
      for (let j = 0; j < 3; j++) {
        const a = v[j];
        const b = v[(j + 1) % 3];
        const k = a < b ? `${a}_${b}` : `${b}_${a}`;
        const arr = edgeMap.get(k);
        if (arr) arr.push(t);
        else edgeMap.set(k, [t]);
      }
    }

    const removed = new Set<number>();
    const additions: number[] = [];
    let changed = false;

    for (const [k, ts] of Array.from(edgeMap)) {
      if (ts.length !== 1) continue; // only boundary edges
      const t = ts[0];
      if (removed.has(t)) continue;
      const [a, b] = k.split("_").map(Number);

      const ax = vertices[a * 3];
      const ay = vertices[a * 3 + 1];
      const az = vertices[a * 3 + 2];
      const ex = vertices[b * 3] - ax;
      const ey = vertices[b * 3 + 1] - ay;
      const ez = vertices[b * 3 + 2] - az;
      const elen2 = ex * ex + ey * ey + ez * ez;
      if (elen2 === 0) continue;

      // Collect vertices that lie strictly on the segment a–b.
      const mids: { vi: number; t: number }[] = [];
      for (let vi = 0; vi < vc; vi++) {
        if (vi === a || vi === b) continue;
        const dx = vertices[vi * 3] - ax;
        const dy = vertices[vi * 3 + 1] - ay;
        const dz = vertices[vi * 3 + 2] - az;
        const param = (dx * ex + dy * ey + dz * ez) / elen2;
        if (param <= 1e-6 || param >= 1 - 1e-6) continue;
        const cx = dy * ez - dz * ey;
        const cy = dz * ex - dx * ez;
        const cz = dx * ey - dy * ex;
        if ((cx * cx + cy * cy + cz * cz) / elen2 > 1e-6) continue;
        mids.push({ vi, t: param });
      }
      if (mids.length === 0) continue;
      mids.sort((m, n) => m.t - n.t);

      // Find the apex vertex and the direction the triangle walks the edge.
      const tv = [tris[t], tris[t + 1], tris[t + 2]];
      let apex = -1;
      let aFirst = true;
      for (let j = 0; j < 3; j++) {
        if (tv[j] === a && tv[(j + 1) % 3] === b) {
          apex = tv[(j + 2) % 3];
          aFirst = true;
          break;
        }
        if (tv[j] === b && tv[(j + 1) % 3] === a) {
          apex = tv[(j + 2) % 3];
          aFirst = false;
          break;
        }
      }
      if (apex === -1) continue;

      removed.add(t);
      changed = true;
      const chain = [a, ...mids.map((m) => m.vi), b];
      for (let i = 0; i < chain.length - 1; i++) {
        const p = chain[i];
        const q = chain[i + 1];
        if (aFirst) additions.push(p, q, apex);
        else additions.push(q, p, apex);
      }
    }

    if (!changed) break;
    const next: number[] = [];
    for (let t = 0; t < tris.length; t += 3) {
      if (!removed.has(t)) next.push(tris[t], tris[t + 1], tris[t + 2]);
    }
    for (const x of additions) next.push(x);
    tris = next;
  }

  return new Uint32Array(tris);
}

/**
 * A closed, consistently oriented mesh walks every edge exactly once in
 * each direction: a→b in one triangle, b→a in its neighbour. Count the
 * edges that don't — an edge used once, three times, or twice the same way
 * round (a cap wound into the solid) all fail that test, and all of them
 * make a slicer ask to repair the file.
 */
function countNonManifoldEdges(triangles: Uint32Array): number {
  const forward = new Map<string, number>();
  for (let i = 0; i < triangles.length; i += 3) {
    const v = [triangles[i], triangles[i + 1], triangles[i + 2]];
    for (let j = 0; j < 3; j++) {
      const key = `${v[j]}_${v[(j + 1) % 3]}`;
      forward.set(key, (forward.get(key) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [key, count] of Array.from(forward)) {
    const [a, b] = key.split("_").map(Number);
    const reverse = forward.get(`${b}_${a}`);
    if (reverse === undefined) {
      bad++; // one-way edge: a border, or a face wound the wrong way
      continue;
    }
    // Count each two-way edge once, from its lower-numbered end.
    if (a < b && (count !== 1 || reverse !== 1)) bad++;
  }
  return bad;
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

  const optsFor = (color: string): PartOptions =>
    optionsByColor.get(color) ?? DEFAULT_PART_OPTIONS;

  // 2. Everything a chamfer might run into.
  const neighboursByColor = new Map<string, Neighbour[]>();
  const allNeighbours: (Neighbour & { color: string })[] = [];
  for (const [color, polys] of Array.from(polysByColor)) {
    const top = Math.max(optsFor(color).extrudeDepth, 0.01);
    for (const poly of polys) {
      allNeighbours.push({ color, poly, bbox: bboxOf(poly.outline), top });
    }
  }
  for (const color of Array.from(polysByColor.keys())) {
    neighboursByColor.set(
      color,
      allNeighbours.filter((nb) => nb.color !== color),
    );
  }

  // 3. Build each polygon, welded and repaired independently (erosion has
  //    already separated them), then merge into the color's mesh.
  const result: ColorMesh[] = [];
  for (const [color, polys] of Array.from(polysByColor)) {
    const opts = optsFor(color);
    const wantsBevel =
      (opts.bevelTop || opts.bevelBottom) &&
      opts.bevelSize > 0 &&
      opts.bevelThickness > 0;
    const neighbours = wantsBevel ? (neighboursByColor.get(color) ?? []) : [];

    const mergedVerts: number[] = [];
    const mergedTris: number[] = [];
    let bevelFallbacks = 0;
    for (const poly of polys) {
      const edges: BevelEdges = wantsBevel
        ? bevelEdges(poly, opts, neighbours)
        : { top: null, bottom: null };
      const built = buildManifoldPoly(poly, opts, edges);
      if (built.bevelFallback) bevelFallbacks++;
      const offset = mergedVerts.length / 3;
      for (let i = 0; i < built.vertices.length; i++) {
        mergedVerts.push(built.vertices[i]);
      }
      for (let i = 0; i < built.triangles.length; i++) {
        mergedTris.push(built.triangles[i] + offset);
      }
    }

    // A color painted over entirely by later ones has nothing left to print.
    if (mergedTris.length === 0) continue;

    const vertices = new Float32Array(mergedVerts);
    const triangles = new Uint32Array(mergedTris);
    result.push({
      color,
      vertices,
      triangles,
      nonManifoldEdges: countNonManifoldEdges(triangles),
      bevelFallbacks,
    });
  }

  // Center the assembly: X/Z centered, model resting on the plate (minY = 0).
  if (result.length > 0) {
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const m of result) {
      const v = m.vertices;
      for (let i = 0; i < v.length; i += 3) {
        if (v[i] < minX) minX = v[i];
        if (v[i] > maxX) maxX = v[i];
        if (v[i + 1] < minY) minY = v[i + 1];
        if (v[i + 2] < minZ) minZ = v[i + 2];
        if (v[i + 2] > maxZ) maxZ = v[i + 2];
      }
    }
    if (Number.isFinite(minX)) {
      const cx = (minX + maxX) / 2;
      const cy = minY;
      const cz = (minZ + maxZ) / 2;
      for (const m of result) {
        const v = m.vertices;
        for (let i = 0; i < v.length; i += 3) {
          v[i] -= cx;
          v[i + 1] -= cy;
          v[i + 2] -= cz;
        }
      }
    }
  }

  return result;
}
