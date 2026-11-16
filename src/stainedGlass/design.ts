import type { Vec2 } from "../solids.js";
import { arcPoints, cubicPoints, quadPoints } from "./flatten.js";

// A reader for the one dialect of SVG a stained-glass design is written
// in: filled shapes and stroked cut lines inside three named groups. It
// works on the text directly — no DOMParser — so it runs the same in a
// browser, in Node and in a Worker, and nothing in the markup is ever
// handed to a document.

export type DesignRegion = "background" | "band" | "letters";

export type DesignShape =
  | {
      kind: "paint";
      region: DesignRegion;
      /** Canonical `#rrggbb`, or null for a fill this couldn't read. */
      fill: string | null;
      /** Closed rings, nonzero fill. */
      rings: Vec2[][];
    }
  | {
      kind: "cut";
      region: DesignRegion;
      /** Open polylines: the centre-lines of the cuts. */
      lines: Vec2[][];
    };

export type ParsedDesign = {
  viewBox: { x: number; y: number; width: number; height: number } | null;
  /** In document order, which is painter's order. */
  shapes: DesignShape[];
  /** Things the dialect doesn't have, counted so the caller can say so. */
  ignored: { transforms: number; elements: number; truncated: boolean };
};

const MAX_LENGTH = 400_000;
const MAX_SHAPES = 1500;
const MAX_POINTS = 4000;
/**
 * Points in a whole design. A busy one — a hundred and fifty shapes, most
 * of them curved — comes to about thirty thousand.
 */
const MAX_DESIGN_POINTS = 40_000;
/** Curve tolerance in design units (millimetres, when the brief is followed). */
const TOLERANCE = 0.02;

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  lime: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  violet: "#ee82ee",
  indigo: "#4b0082",
  navy: "#000080",
  teal: "#008080",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  maroon: "#800000",
  olive: "#808000",
  gold: "#ffd700",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
};

const byte = (n: number) =>
  Math.min(255, Math.max(0, Math.round(n)))
    .toString(16)
    .padStart(2, "0");

/** A CSS color → `#rrggbb`; `"none"` for no paint; null when unreadable. */
export function readColor(raw: string | undefined): string | "none" | null {
  if (raw === undefined) return null;
  const s = raw.trim().toLowerCase();
  if (s === "") return null;
  if (s === "none" || s === "transparent") return "none";
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7);
  if (/^#[0-9a-f]{3,4}$/.test(s))
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  const rgb = /^rgba?\(([^)]*)\)$/.exec(s);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const [r, g, b] = parts
        .slice(0, 3)
        .map((p) =>
          p.endsWith("%") ? (parseFloat(p) * 255) / 100 : parseFloat(p),
        );
      if ([r, g, b].every(Number.isFinite))
        return `#${byte(r)}${byte(g)}${byte(b)}`;
    }
    return null;
  }
  return NAMED[s] ?? null;
}

const numbersOf = (text: string): number[] =>
  (text.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? []).map(Number);

type Subpath = { points: Vec2[]; closed: boolean };

/** SVG path data → polylines. Every command of the full grammar. */
export function readPathData(
  d: string,
  /** Points left for the whole design; this path spends from it */
  pool: { left: number } = { left: MAX_POINTS * 2 },
): Subpath[] {
  const out: Subpath[] = [];
  const tokens =
    d.match(/[a-z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? [];
  let i = 0;
  let command = "";
  let at: Vec2 = { x: 0, y: 0 };
  let start: Vec2 = { x: 0, y: 0 };
  let control: Vec2 | null = null; // last control point, for S and T
  let previous = "";
  let current: Subpath | null = null;
  let budget = Math.min(MAX_POINTS * 2, pool.left);

  const isNumber = (t: string | undefined) =>
    t !== undefined && !/^[a-z]$/i.test(t);
  const next = (): number => Number(tokens[i++]);
  const flag = (): boolean => {
    // A flag is one character, and minifiers run it into what follows:
    // "a5 5 0 01 10 10", or "a5 5 0 011.5 1" for flags 0 and 1, then 1.5
    const t = tokens[i];
    if (t !== undefined && t.length > 1 && /^[01]/.test(t)) {
      tokens[i] = t.slice(1);
      return t[0] === "1";
    }
    return next() !== 0;
  };
  const push = (points: Vec2[]) => {
    if (!current) {
      current = { points: [{ ...at }], closed: false };
      out.push(current);
    }
    for (const p of points) {
      if (budget-- <= 0) return;
      pool.left--;
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) current.points.push(p);
    }
  };

  while (i < tokens.length && budget > 0) {
    const before = i;
    if (!isNumber(tokens[i])) command = tokens[i++];
    else if (command === "") break;
    else if (command === "M") command = "L";
    else if (command === "m") command = "l";
    const relative = command === command.toLowerCase();
    const op = command.toUpperCase();
    const point = (): Vec2 => {
      const x = next();
      const y = next();
      return relative ? { x: at.x + x, y: at.y + y } : { x, y };
    };

    switch (op) {
      case "M": {
        if (!isNumber(tokens[i])) break;
        at = point();
        start = at;
        current = { points: [{ ...at }], closed: false };
        out.push(current);
        break;
      }
      case "L": {
        if (!isNumber(tokens[i])) break;
        at = point();
        push([at]);
        break;
      }
      case "H": {
        if (!isNumber(tokens[i])) break;
        const x = next();
        at = { x: relative ? at.x + x : x, y: at.y };
        push([at]);
        break;
      }
      case "V": {
        if (!isNumber(tokens[i])) break;
        const y = next();
        at = { x: at.x, y: relative ? at.y + y : y };
        push([at]);
        break;
      }
      case "C": {
        if (!isNumber(tokens[i])) break;
        const c1 = point();
        const c2 = point();
        const to = point();
        push(cubicPoints(at, c1, c2, to, TOLERANCE));
        control = c2;
        at = to;
        break;
      }
      case "S": {
        if (!isNumber(tokens[i])) break;
        const c1: Vec2 =
          control && (previous === "C" || previous === "S")
            ? { x: 2 * at.x - control.x, y: 2 * at.y - control.y }
            : { ...at };
        const c2 = point();
        const to = point();
        push(cubicPoints(at, c1, c2, to, TOLERANCE));
        control = c2;
        at = to;
        break;
      }
      case "Q": {
        if (!isNumber(tokens[i])) break;
        const c1 = point();
        const to = point();
        push(quadPoints(at, c1, to, TOLERANCE));
        control = c1;
        at = to;
        break;
      }
      case "T": {
        if (!isNumber(tokens[i])) break;
        const c1: Vec2 =
          control && (previous === "Q" || previous === "T")
            ? { x: 2 * at.x - control.x, y: 2 * at.y - control.y }
            : { ...at };
        const to = point();
        push(quadPoints(at, c1, to, TOLERANCE));
        control = c1;
        at = to;
        break;
      }
      case "A": {
        if (!isNumber(tokens[i])) break;
        const rx = next();
        const ry = next();
        const rotation = next();
        const large = flag();
        const sweep = flag();
        const to = point();
        push(arcPoints(at, rx, ry, rotation, large, sweep, to, TOLERANCE));
        at = to;
        break;
      }
      case "Z": {
        if (current) current.closed = true;
        at = start;
        current = null;
        break;
      }
      default:
        // Not a path command: skip whatever numbers follow it
        while (isNumber(tokens[i])) i++;
    }
    previous = op;
    if (Number.isNaN(at.x) || Number.isNaN(at.y)) break;
    // Numbers after a closepath ("Z 1") belong to no command: nothing
    // above reads them, and going round again would never end. The path
    // is in error from here, so keep what was drawn and stop, as a
    // browser does.
    if (i === before) break;
  }
  return out.filter((s) => s.points.length >= 2);
}

const ellipse = (cx: number, cy: number, rx: number, ry: number): Vec2[] => {
  if (!(rx > 0) || !(ry > 0)) return [];
  const r = Math.max(rx, ry);
  const n = Math.min(
    96,
    Math.max(
      12,
      Math.ceil(
        Math.PI / Math.acos(Math.max(0, 1 - Math.min(TOLERANCE, r) / r)),
      ),
    ),
  );
  const points: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    points.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return points;
};

/**
 * `text` without its `open … close` spans. Done by hand because the regex
 * for it goes quadratic on a run of opens with no close; an open that
 * never closes takes the rest of the text with it, as it does in a browser.
 */
const strip = (text: string, open: string, close: string): string => {
  let out = "";
  let at = 0;
  for (;;) {
    const from = text.indexOf(open, at);
    if (from < 0) return out + text.slice(at);
    out += text.slice(at, from);
    const to = text.indexOf(close, from + open.length);
    if (to < 0) return out;
    at = to + close.length;
  }
};

type Attributes = Record<string, string>;

const readAttributes = (text: string): Attributes => {
  const attributes: Attributes = {};
  // A name starts where a name isn't already under way. Without that, one
  // long word with no "=" after it is tried again from every letter of it.
  const pattern =
    /(?<![\w:.-])([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    attributes[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  // `style="fill:#f00"` outranks the attribute, as it does in a browser
  const style = attributes.style;
  if (style) {
    for (const declaration of style.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      if (property === "fill" || property === "stroke") {
        attributes[property] = declaration.slice(colon + 1).trim();
      }
    }
  }
  return attributes;
};

const REGIONS: readonly DesignRegion[] = ["background", "band", "letters"];
const SHAPES = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "polygon",
  "polyline",
  "line",
]);
const STRUCTURE = new Set(["svg", "g", "title", "desc"]);
/** Elements whose contents aren't drawn. */
const SKIPPED = new Set([
  "defs",
  "clippath",
  "mask",
  "pattern",
  "symbol",
  "marker",
  "style",
  "script",
  "metadata",
  "text",
  "foreignobject",
  "lineargradient",
  "radialgradient",
  "filter",
]);

/**
 * Read a design. Throws when the text has no `<svg>` in it; anything else
 * it doesn't understand is skipped and counted in `ignored`.
 */
export function parseDesign(svgText: string): ParsedDesign {
  let text = String(svgText ?? "");
  const ignored = { transforms: 0, elements: 0, truncated: false };
  if (text.length > MAX_LENGTH) {
    text = text.slice(0, MAX_LENGTH);
    ignored.truncated = true;
  }
  text = strip(strip(text, "<!--", "-->"), "<![CDATA[", "]]>");
  if (!/<svg[\s>]/i.test(text))
    throw new Error("That isn't an SVG: there's no <svg> element in it");

  const shapes: DesignShape[] = [];
  let viewBox: ParsedDesign["viewBox"] = null;
  type Frame = {
    region: DesignRegion | null;
    fill?: string;
    stroke?: string;
    skip: boolean;
    name: string;
  };
  const stack: Frame[] = [{ region: null, skip: false, name: "" }];

  // `<` is kept out of the attribute run on purpose: with it in, every
  // unclosed "<g" scans to the end of the text before giving up, and a run
  // of them takes seconds
  const tag = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^<>"'])*?)(\/?)>/g;
  const pool = { left: MAX_DESIGN_POINTS };
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    const closing = m[1] === "/";
    const name = m[2].toLowerCase().replace(/^svg:/, "");
    const selfClosing = m[4] === "/";
    const top = stack[stack.length - 1];

    if (closing) {
      // Pop to the matching open tag; a stray close is ignored
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const attributes = readAttributes(m[3]);
    const container = !SHAPES.has(name);
    if (container) {
      if (name === "svg" && !viewBox) {
        const vb = numbersOf(attributes.viewbox ?? "");
        if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
          viewBox = { x: vb[0], y: vb[1], width: vb[2], height: vb[3] };
        } else {
          const w = parseFloat(attributes.width ?? "");
          const h = parseFloat(attributes.height ?? "");
          if (w > 0 && h > 0) viewBox = { x: 0, y: 0, width: w, height: h };
        }
      }
      if (!STRUCTURE.has(name) && !SKIPPED.has(name)) ignored.elements++;
      if (attributes.transform) ignored.transforms++;
      if (!selfClosing) {
        const id = (attributes.id ?? "").toLowerCase();
        stack.push({
          name,
          region: (REGIONS as readonly string[]).includes(id)
            ? (id as DesignRegion)
            : top.region,
          fill: attributes.fill ?? top.fill,
          stroke: attributes.stroke ?? top.stroke,
          skip: top.skip || SKIPPED.has(name) || !STRUCTURE.has(name),
        });
      }
      continue;
    }

    if (top.skip) continue;
    if (shapes.length >= MAX_SHAPES || pool.left <= 0) {
      ignored.truncated = true;
      break;
    }
    if (attributes.transform) ignored.transforms++;

    const value = (key: string) => parseFloat(attributes[key] ?? "0") || 0;
    let subpaths: Subpath[] = [];
    switch (name) {
      case "path":
        subpaths = readPathData(attributes.d ?? "", pool);
        break;
      case "rect": {
        const x = value("x");
        const y = value("y");
        const w = value("width");
        const h = value("height");
        if (w > 0 && h > 0) {
          subpaths = [
            {
              closed: true,
              points: [
                { x, y },
                { x: x + w, y },
                { x: x + w, y: y + h },
                { x, y: y + h },
              ],
            },
          ];
        }
        break;
      }
      case "circle":
        subpaths = [
          {
            closed: true,
            points: ellipse(value("cx"), value("cy"), value("r"), value("r")),
          },
        ];
        break;
      case "ellipse":
        subpaths = [
          {
            closed: true,
            points: ellipse(value("cx"), value("cy"), value("rx"), value("ry")),
          },
        ];
        break;
      case "polygon":
      case "polyline": {
        const n = numbersOf(attributes.points ?? "").slice(0, MAX_POINTS * 2);
        const points: Vec2[] = [];
        for (let k = 0; k + 1 < n.length; k += 2)
          points.push({ x: n[k], y: n[k + 1] });
        subpaths = [{ closed: name === "polygon", points }];
        break;
      }
      case "line":
        subpaths = [
          {
            closed: false,
            points: [
              { x: value("x1"), y: value("y1") },
              { x: value("x2"), y: value("y2") },
            ],
          },
        ];
        break;
    }
    subpaths = subpaths.filter((s) => s.points.length >= 2);
    if (subpaths.length === 0) continue;
    // Paths spend from the pool as they're read; the other shapes here
    if (name !== "path") {
      for (const s of subpaths) pool.left -= s.points.length;
    }
    // Said here and not only when the next shape is turned away: the one
    // that emptied the pool may be the last, and was itself cut short
    if (pool.left <= 0) ignored.truncated = true;

    const region = top.region ?? "background";
    const fill = readColor(attributes.fill ?? top.fill);
    const stroke = readColor(attributes.stroke ?? top.stroke);
    const stroked = stroke !== null && stroke !== "none";
    // A line has no inside; a shape with its fill switched off is a cut
    // when it has a stroke to say where
    if (name === "line" || fill === "none") {
      if (!stroked) continue;
      shapes.push({
        kind: "cut",
        region,
        lines: subpaths.map((s) =>
          s.closed ? [...s.points, s.points[0]] : s.points,
        ),
      });
      continue;
    }
    const rings = subpaths.map((s) => s.points).filter((p) => p.length >= 3);
    if (rings.length === 0) continue;
    // No fill attribute at all is SVG's default black
    const unset = attributes.fill === undefined && top.fill === undefined;
    shapes.push({
      kind: "paint",
      region,
      fill: unset ? "#000000" : fill,
      rings,
    });
  }

  return { viewBox, shapes, ignored };
}
