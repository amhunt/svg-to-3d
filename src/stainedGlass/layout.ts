import type { Vec2 } from "../solids.js";
import { cubicPoints, quadPoints } from "./flatten.js";
import {
  stainedGlassTargets,
  type BriefBox,
  type StainedGlassBrief,
  type StainedGlassTargets,
} from "./prompt.js";

/**
 * The colors of the sign this was modelled on: lead first, then glass.
 * A panel with `colors: 4` uses the first four.
 */
export const DEFAULT_STAINED_GLASS_PALETTE: readonly string[] = [
  "#080910", // lead
  "#cd000e", // red
  "#fdbc00", // yellow
  "#3c8dea", // blue
  "#f7931e", // orange
  "#2c4184", // navy
  "#2e9e6b", // green
  "#a7d3f5", // pale blue
];

/** One drawing command of a glyph outline, as opentype.js spells them. */
export type GlyphPathCommand = {
  type: string;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
};

/**
 * The little of a font this needs. A font parsed by opentype.js fits as it
 * is — `layoutStainedGlass({ text, font: opentype.parse(bytes), width })` —
 * and so does anything else that can hand back a glyph's outline.
 */
export interface FontLike {
  unitsPerEm: number;
  stringToGlyphs(text: string): {
    /** 0 is the font's "missing glyph" box. */
    index?: number;
    /** The outline with its baseline at `y`, y pointing down. */
    getPath(
      x: number,
      y: number,
      fontSize: number,
    ): { commands: GlyphPathCommand[] };
  }[];
}

export type StainedGlassLayoutOptions = {
  /** One line. Empty gives a plain panel with no word on it. */
  text: string;
  /** Required unless `text` is empty. */
  font?: FontLike;
  /**
   * Overall width in mm, frame included. The height follows from the text:
   * a longer word makes a flatter panel.
   */
  width: number;
  /** Overall height in mm. Only read when `text` is empty. */
  height?: number;
  /** Width of the outer frame, mm. Default 3.7. */
  frameWidth?: number;
  /** Width of the lead between pieces of glass, mm. Default 2.2. */
  leadWidth?: number;
  /** How finely the glass is broken up, 1 (a few panes) to 10. Default 6. */
  shards?: number;
  /** Total colors, lead included. Default 4. */
  colors?: number;
  /**
   * `#rrggbb` colors, lead first, each one different. Shorter than
   * `colors`, it's topped up from `DEFAULT_STAINED_GLASS_PALETTE`.
   */
  palette?: readonly string[];
  /** Glass between the word and the frame, as a multiple of the letter height. Default 0.57. */
  margin?: number;
  /** Gap between letters, mm. Default (and never less than) `leadWidth`. */
  letterSpacing?: number;
  /** The narrowest glass worth printing, mm. Default 0.8. */
  minFeature?: number;
};

/** `x`, `y` of the top-left corner; millimetres, y down. */
export type Box = { x: number; y: number; width: number; height: number };

export type StainedGlassWarning = {
  /** Stable, for code: `"missing-glyph"`, `"dropped-pieces"`, … */
  code: string;
  /** A sentence for a person. */
  message: string;
};

export type StainedGlassLetter = {
  char: string;
  /** The letter's ink, which is exactly where its glass ends up. */
  box: Box;
  /** Its outline as closed rings, nonzero fill. */
  rings: Vec2[][];
};

/**
 * A panel measured out: how big it is and where the word sits. Everything
 * downstream — the prompt, the starter design, the build — reads its
 * numbers from here, so they can't disagree about a size.
 */
export type StainedGlassLayout = {
  text: string;
  size: { width: number; height: number };
  frameWidth: number;
  leadWidth: number;
  minFeature: number;
  /** The glass area: the panel less its frame. */
  inner: Box;
  /** The box around the word, or null when there's no text. */
  band: Box | null;
  letters: StainedGlassLetter[];
  /** Lead, then glass; `colors` long. */
  palette: string[];
  shards: number;
  targets: StainedGlassTargets;
  /** Characters the font had no glyph for; they were left out. */
  missing: string[];
  warnings: StainedGlassWarning[];
  /** The same panel as plain JSON, for `stainedGlassPrompt`. */
  brief: StainedGlassBrief;
};

const positive = (
  value: number | undefined,
  fallback: number,
  name: string,
): number => {
  const v = value ?? fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new RangeError(`${name} must be a positive number of millimetres`);
  }
  return v;
};

const normalizeHex = (color: string): string => {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c))
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  throw new RangeError(`"${color}" isn't a #rrggbb color`);
};

function paletteFor(
  colors: number,
  given: readonly string[] | undefined,
): string[] {
  if (!Number.isInteger(colors) || colors < 2 || colors > 12) {
    throw new RangeError(
      "colors must be a whole number from 2 to 12, lead included",
    );
  }
  const palette = (given ?? []).map(normalizeHex);
  for (const fallback of DEFAULT_STAINED_GLASS_PALETTE) {
    if (palette.length >= colors) break;
    if (!palette.includes(fallback)) palette.push(fallback);
  }
  if (palette.length < colors) {
    throw new RangeError(
      `colors is ${colors} but only ${palette.length} are available; pass a longer palette`,
    );
  }
  const used = palette.slice(0, colors);
  // A part is told from the next by its color, so two slots the same
  // color would come out as one part and every slot after them would
  // move up; the lead's color on a piece of glass would lose the glass.
  const twice = used.find((color, i) => used.indexOf(color) !== i);
  if (twice) {
    throw new RangeError(
      `palette colors must all be different, and ${twice} is there twice`,
    );
  }
  return used;
}

/** A glyph's outline as closed rings, in whatever units the path is in. */
function ringsOf(commands: GlyphPathCommand[], tolerance: number): Vec2[][] {
  const rings: Vec2[][] = [];
  let ring: Vec2[] = [];
  let at: Vec2 = { x: 0, y: 0 };
  const close = () => {
    if (ring.length >= 3) rings.push(ring);
    ring = [];
  };
  for (const c of commands) {
    const to = { x: c.x ?? at.x, y: c.y ?? at.y };
    switch (c.type) {
      case "M":
        close();
        ring = [to];
        at = to;
        break;
      case "L":
        ring.push(to);
        at = to;
        break;
      case "Q":
        ring.push(
          ...quadPoints(
            at,
            { x: c.x1 ?? at.x, y: c.y1 ?? at.y },
            to,
            tolerance,
          ),
        );
        at = to;
        break;
      case "C":
        ring.push(
          ...cubicPoints(
            at,
            { x: c.x1 ?? at.x, y: c.y1 ?? at.y },
            { x: c.x2 ?? to.x, y: c.y2 ?? to.y },
            to,
            tolerance,
          ),
        );
        at = to;
        break;
      case "Z":
        close();
        break;
    }
  }
  close();
  return rings;
}

const boundsOfRings = (rings: Vec2[][]): [number, number, number, number] => {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  return [x0, y0, x1, y1];
};

/** Nonzero winding test, the rule font outlines are filled by. */
const insideRings = (x: number, y: number, rings: Vec2[][]): boolean => {
  let winding = 0;
  for (const ring of rings) {
    for (let i = 0, n = ring.length; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      if (a.y <= y === b.y <= y) continue;
      const cross = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
      if (b.y > a.y ? cross > 0 : cross < 0) winding += b.y > a.y ? 1 : -1;
    }
  }
  return winding !== 0;
};

const ringArea = (ring: Vec2[]): number => {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};

const ringLength = (ring: Vec2[]): number => {
  let len = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    len += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return len;
};

const briefBox = (b: Box): BriefBox => [
  b.x,
  b.y,
  b.x + b.width,
  b.y + b.height,
];
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Measure a panel out. Nothing is drawn yet: this settles how big the
 * panel is, where the frame ends and where each letter sits, in
 * millimetres with the origin at the top-left.
 *
 * The letters are set a lead's width apart, ink to ink, and the word is
 * given the same margin of glass on all four sides. Fixing `width` then
 * fixes everything: the letters scale until the word and its margins fill
 * the width, and the height is whatever that makes it.
 *
 * Throws a `RangeError` for a size that can't work — a width too small for
 * the word, a negative lead. Characters the font can't draw are left out
 * and listed in `missing`.
 */
export function layoutStainedGlass(
  options: StainedGlassLayoutOptions,
): StainedGlassLayout {
  const width = positive(options.width, NaN, "width");
  const frameWidth = positive(options.frameWidth, 3.7, "frameWidth");
  const leadWidth = positive(options.leadWidth, 2.2, "leadWidth");
  const minFeature = positive(options.minFeature, 0.8, "minFeature");
  const margin = positive(options.margin, 0.57, "margin");
  const spacing = Math.max(leadWidth, options.letterSpacing ?? leadWidth);
  if (options.shards != null && !Number.isFinite(options.shards)) {
    throw new RangeError("shards must be a number from 1 to 10");
  }
  const shards = Math.min(10, Math.max(1, Math.round(options.shards ?? 6)));
  const palette = paletteFor(options.colors ?? 4, options.palette);
  if (frameWidth < leadWidth / 2) {
    throw new RangeError("frameWidth can't be less than half of leadWidth");
  }

  const warnings: StainedGlassWarning[] = [];
  const missing: string[] = [];
  const text = options.text ?? "";
  const chars = Array.from(text.trim());

  // Each character's outline in font units, baseline at y = 0.
  type Slot =
    | {
        char: string;
        commands: GlyphPathCommand[];
        box: [number, number, number, number];
      }
    | { gap: true };
  const slots: Slot[] = [];
  let em = 1000;
  if (chars.length > 0) {
    const font = options.font;
    if (!font) throw new RangeError("a font is required to set text");
    em = font.unitsPerEm || 1000;
    for (const char of chars) {
      if (/\s/.test(char)) {
        if (slots.length > 0 && !("gap" in slots[slots.length - 1]))
          slots.push({ gap: true });
        continue;
      }
      // A soft hyphen, a zero-width joiner: there, but not a letter. A
      // font may well draw one, and a sign shouldn't.
      if (/\p{C}/u.test(char)) continue;
      const glyph = font.stringToGlyphs(char)[0];
      const commands =
        glyph && glyph.index !== 0 ? glyph.getPath(0, 0, em).commands : [];
      const rough = ringsOf(commands, em / 400);
      if (rough.length === 0) {
        if (!missing.includes(char)) missing.push(char);
        continue;
      }
      slots.push({ char, commands, box: boundsOfRings(rough) });
    }
    while (slots.length > 0 && "gap" in slots[slots.length - 1]) slots.pop();
  }
  if (missing.length > 0) {
    warnings.push({
      code: "missing-glyph",
      message: `The font has no glyph for ${missing.map((c) => `"${c}"`).join(", ")}, so ${missing.length === 1 ? "it was" : "they were"} left out.`,
    });
  }

  const glyphs = slots.filter(
    (s): s is Exclude<Slot, { gap: true }> => !("gap" in s),
  );
  const inner0 = { x: frameWidth, y: frameWidth };
  let height: number;
  let band: Box | null = null;
  const letters: StainedGlassLetter[] = [];

  if (glyphs.length === 0) {
    height = positive(options.height, width / 3, "height");
  } else {
    const top = Math.min(...glyphs.map((g) => g.box[1]));
    const bottom = Math.max(...glyphs.map((g) => g.box[3]));
    const bandUnits = bottom - top;
    const gapUnits = 0.35 * bandUnits;
    let inkUnits = 0;
    let gaps = 0;
    for (const slot of slots) {
      if ("gap" in slot) inkUnits += gapUnits;
      else inkUnits += slot.box[2] - slot.box[0];
    }
    gaps = slots.length - 1;
    // width = 2·frame + 2·margin·band + ink + gaps·spacing, all but the
    // spacing and the frame scaling with the letters
    const scale =
      (width - 2 * frameWidth - gaps * spacing) /
      (inkUnits + 2 * margin * bandUnits);
    const bandHeight = bandUnits * scale;
    if (!(scale > 0) || bandHeight < 4 * leadWidth) {
      throw new RangeError(
        `${width} mm is too narrow for "${chars.join("")}" with ${leadWidth} mm lead: widen the panel, thin the lead or shorten the text`,
      );
    }
    const pad = margin * bandHeight;
    height = 2 * frameWidth + 2 * pad + bandHeight;
    const bandX = inner0.x + pad;
    const bandY = inner0.y + pad;
    const tolerance = 0.02 / scale;
    let cursor = bandX;
    let thinnest = Infinity;
    for (const slot of slots) {
      if ("gap" in slot) {
        cursor += gapUnits * scale + spacing;
        continue;
      }
      const dx = cursor - slot.box[0] * scale;
      const dy = bandY - top * scale;
      const rings = ringsOf(slot.commands, tolerance).map((ring) =>
        ring.map((p) => ({ x: p.x * scale + dx, y: p.y * scale + dy })),
      );
      const [x0, y0, x1, y1] = boundsOfRings(rings);
      letters.push({
        char: slot.char,
        box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
        rings,
      });
      // Twice the area over the perimeter is the stroke width of anything
      // long and thin, which is what a letter is.
      const area = Math.abs(rings.reduce((sum, r) => sum + ringArea(r), 0));
      const perimeter = rings.reduce((sum, r) => sum + ringLength(r), 0);
      if (perimeter > 0) thinnest = Math.min(thinnest, (2 * area) / perimeter);
      cursor = x1 + spacing;
    }
    const last = letters[letters.length - 1];
    band = {
      x: bandX,
      y: bandY,
      width: last.box.x + last.box.width - bandX,
      height: bandHeight,
    };
    if (thinnest < leadWidth + minFeature) {
      warnings.push({
        code: "thin-letters",
        message: `The letters' strokes are about ${round2(thinnest)} mm wide, which leaves little glass beside ${leadWidth} mm lead. A heavier font, a wider panel or thinner lead will read better.`,
      });
    }
  }

  const size = { width, height };
  const inner: Box = {
    x: frameWidth,
    y: frameWidth,
    width: width - 2 * frameWidth,
    height: height - 2 * frameWidth,
  };
  if (inner.width < 4 * leadWidth || inner.height < 4 * leadWidth) {
    throw new RangeError(
      "the frame leaves no room for glass: widen the panel or thin the frame",
    );
  }

  // Don't ask for more pieces than there is room to print.
  const targets = stainedGlassTargets(shards);
  const bandArea = band ? band.width * band.height : 0;
  const backgroundArea = inner.width * inner.height - bandArea;
  targets.background = Math.max(
    2,
    Math.min(
      targets.background,
      Math.floor(backgroundArea / (5 * leadWidth) ** 2),
    ),
  );
  targets.cuts = Math.min(targets.cuts, Math.round(targets.background / 4) + 1);
  if (letters.length > 0) {
    const ink =
      letters.reduce(
        (sum, l) =>
          sum + Math.abs(l.rings.reduce((s, r) => s + ringArea(r), 0)),
        0,
      ) / letters.length;
    targets.perLetter = Math.max(
      1,
      Math.min(targets.perLetter, Math.floor(ink / (3.5 * leadWidth) ** 2)),
    );
  }

  // A coarse picture of where the ink is, so the model can aim its cuts.
  let map: StainedGlassBrief["map"] = null;
  if (band) {
    const cell = Math.max(band.height / 8, band.width / 96);
    const columns = Math.max(1, Math.round(band.width / cell));
    const rowCount = Math.max(1, Math.round(band.height / cell));
    const rows: string[] = [];
    for (let r = 0; r < rowCount; r++) {
      const y = band.y + ((r + 0.5) * band.height) / rowCount;
      let row = "";
      for (let c = 0; c < columns; c++) {
        const x = band.x + ((c + 0.5) * band.width) / columns;
        const hit = letters.some(
          (l) =>
            x >= l.box.x &&
            x <= l.box.x + l.box.width &&
            insideRings(x, y, l.rings),
        );
        row += hit ? "#" : ".";
      }
      rows.push(row);
    }
    map = { cell: round2(cell), rows };
  }

  const roundBox = (b: Box): BriefBox => briefBox(b).map(round2) as BriefBox;
  const brief: StainedGlassBrief = {
    width: round2(width),
    height: round2(height),
    frameWidth,
    leadWidth,
    minFeature,
    inner: roundBox(inner),
    band: band ? roundBox(band) : null,
    letters: letters.map((l) => ({ char: l.char, box: roundBox(l.box) })),
    glass: palette.slice(1),
    targets,
    map,
  };

  return {
    text: chars.join(""),
    size,
    frameWidth,
    leadWidth,
    minFeature,
    inner,
    band,
    letters,
    palette,
    shards,
    targets,
    missing,
    warnings,
    brief,
  };
}
