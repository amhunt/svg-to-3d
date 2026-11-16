// The brief a language model draws a stained-glass design from, and the two
// checks on what goes in and comes out. No imports on purpose: this file is
// what a server bundles to make the call, and it should cost a few KB.

/** `[x0, y0, x1, y1]` in millimetres, origin at the panel's top-left, y down. */
export type BriefBox = [number, number, number, number];

/** How many pieces to aim for; advice for the model, not a guarantee. */
export type StainedGlassTargets = {
  /** Glass pieces outside the word. */
  background: number;
  /** Cut lines across the background that get them there. */
  cuts: number;
  /** Pieces each letter is split into. */
  perLetter: number;
};

/**
 * Everything the model needs to know about one panel, as plain JSON. It's
 * `layout.brief` on the client and the request body on the server:
 * numbers, single characters and hex colors only, so nothing in it can
 * steer the model.
 */
export type StainedGlassBrief = {
  width: number;
  height: number;
  frameWidth: number;
  leadWidth: number;
  minFeature: number;
  /** The glass area inside the frame. */
  inner: BriefBox;
  /** The box around the word, or null for a panel with no text. */
  band: BriefBox | null;
  letters: { char: string; box: BriefBox }[];
  /** Glass colors as `#rrggbb`; the lead color isn't the model's to use. */
  glass: string[];
  targets: StainedGlassTargets;
  /** Where the letters' ink is: one string per row, `#` for ink. */
  map: { cell: number; rows: string[] } | null;
};

const BACKGROUND_TARGETS = [6, 9, 13, 18, 24, 31, 38, 46, 56, 68];
const PER_LETTER_TARGETS = [1, 1, 2, 2, 2, 3, 3, 3, 4, 4];

/**
 * Piece counts for a 1–10 density. 1 is a handful of big panes, 10 is a
 * mosaic; the sign this was modelled on sits at 7.
 */
export function stainedGlassTargets(shards: number): StainedGlassTargets {
  const i = Math.min(10, Math.max(1, Math.round(shards))) - 1;
  const background = BACKGROUND_TARGETS[i];
  return {
    background,
    cuts: Math.round(background / 4) + 1,
    perLetter: PER_LETTER_TARGETS[i],
  };
}

const SYSTEM = `You design stained-glass panels as SVG. A program turns your drawing into glass and lead: it puts lead of the correct width along every edge where two shapes meet and along every cut line, and it adds the frame and the exact letter outlines. Never draw lead, outlines or letterforms.

Reply with one <svg> element only. No markdown, comments, <style>, <defs>, <text>, transform, gradients or opacity.

Format
- <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H">, in millimetres, at most one decimal.
- Three groups in this order: <g id="background">, <g id="band">, <g id="letters">.
- Paint: path, polygon, rect, circle or ellipse with fill set to a palette hex. Path commands M L C Q A Z, absolute. Later shapes cover earlier ones, so overlap generously instead of matching edges.
- Cut: <path fill="none" stroke="#000" d="..."/>, a line where glass is split. It splits only its own group. Run cuts past the edge of the area they cross.
- Every attribute value in double quotes.

Groups
- background: first a rect covering the viewBox. Then a few large color areas, one simple motif if the theme asks for it, and long gently curved cuts from edge to edge that cross each other. The band hides what is under it, so lines should seem to pass behind it.
- band: the rectangle around the word, seen between and inside the letters. One flat color that contrasts with the letters; cut it only if the panel is meant to be busy.
- letters: shows only inside the letter shapes. Cover every letter box with paint, then cut each letter into a few segments where its strokes join. Letter pieces are smaller than background pieces.

Color: palette colors only, every color used at least once, strongest contrast between the letters and the band.

Example for a 100 x 40 panel:
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><g id="background"><rect width="100" height="40" fill="#3c8dea"/><path d="M0 40 L0 22 C30 12 60 30 100 16 L100 40 Z" fill="#fdbc00"/><path fill="none" stroke="#000" d="M-5 8 C30 20 70 -4 105 14"/><path fill="none" stroke="#000" d="M30 -5 C36 15 24 28 34 45"/></g><g id="band"><rect x="18" y="11" width="64" height="18" fill="#fdbc00"/></g><g id="letters"><rect x="18" y="11" width="64" height="18" fill="#cd000e"/><path fill="none" stroke="#000" d="M15 21 L85 19"/></g></svg>`;

const n1 = (n: number) => String(Math.round(n * 10) / 10);
const span = (a: number, b: number) => `${n1(a)}-${n1(b)}`;

/** What `notes` may carry into the prompt: one line, no markup, capped. */
const tidyNotes = (notes: string | undefined): string =>
  (notes ?? "").replace(/[<>`]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * The system and user messages for any chat model. Send them as they are;
 * the reply goes through `extractStainedGlassSvg` and then to
 * `buildStainedGlass`.
 *
 * `notes` is the one piece of free text ("a sun rising behind the letters").
 * It's trimmed to a line of 200 characters, but it is still someone's
 * words: moderate it the way you would any prompt.
 */
export function stainedGlassPrompt(
  brief: StainedGlassBrief,
  options: { notes?: string } = {},
): { system: string; user: string } {
  const lines: string[] = [];
  const [ix0, iy0, ix1, iy1] = brief.inner;
  lines.push(
    `Panel ${n1(brief.width)} x ${n1(brief.height)} mm. Glass area x ${span(ix0, ix1)}, y ${span(iy0, iy1)}.`,
  );
  if (brief.band) {
    const [bx0, by0, bx1, by1] = brief.band;
    lines.push(`Band x ${span(bx0, bx1)}, y ${span(by0, by1)}.`);
    lines.push("Letters:");
    for (const letter of brief.letters) {
      const [x0, y0, x1, y1] = letter.box;
      lines.push(`${letter.char} x ${span(x0, x1)} y ${span(y0, y1)}`);
    }
    if (brief.map) {
      lines.push(
        `Letter map of the band, 1 character = ${n1(brief.map.cell)} mm, # = letter:`,
        ...brief.map.rows,
      );
    }
  } else {
    lines.push(
      'No word on this panel: leave the "band" and "letters" groups empty.',
    );
  }
  lines.push(
    `Lead is ${n1(brief.leadWidth)} mm wide and glass narrower than ${n1(brief.minFeature + brief.leadWidth)} mm is lost, so keep cuts and edges at least ${n1(3 * brief.leadWidth)} mm apart and avoid angles under 25 degrees.`,
    `Palette: ${brief.glass.join(" ")}`,
    `Targets: about ${brief.targets.background} background pieces (about ${brief.targets.cuts} cuts)${brief.band ? `, ${brief.targets.perLetter} ${brief.targets.perLetter === 1 ? "piece" : "pieces"} per letter` : ""}.`,
    `Theme: ${tidyNotes(options.notes) || "abstract shards, no motif"}`,
  );
  return { system: SYSTEM, user: lines.join("\n") };
}

const HEX = /^#[0-9a-f]{6}$/;
/** More letters than this and it's a paragraph, not a sign */
const MAX_LETTERS = 64;

const num = (
  value: unknown,
  name: string,
  min: number,
  max: number,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new TypeError(`brief.${name} must be a number from ${min} to ${max}`);
  }
  return value;
};

const box = (value: unknown, name: string): BriefBox => {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new TypeError(`brief.${name} must be [x0, y0, x1, y1]`);
  }
  return value.map((v, i) =>
    num(v, `${name}[${i}]`, -10_000, 10_000),
  ) as BriefBox;
};

/**
 * Rebuild a brief from untrusted JSON, keeping only what the prompt uses.
 * Throws a `TypeError` naming the first field that isn't what it should be.
 * Anything `layoutStainedGlass` lays out passes, up to 64 letters on a
 * panel up to five metres across.
 * Run a request body through this before `stainedGlassPrompt`: afterwards
 * the brief holds numbers, hex colors and single printable characters, and
 * nothing else.
 */
export function parseStainedGlassBrief(value: unknown): StainedGlassBrief {
  if (!value || typeof value !== "object")
    throw new TypeError("brief must be an object");
  const v = value as Record<string, unknown>;

  if (!Array.isArray(v.letters) || v.letters.length > MAX_LETTERS) {
    throw new TypeError(
      `brief.letters must be a list of at most ${MAX_LETTERS} letters`,
    );
  }
  const letters = v.letters.map((raw, i) => {
    const letter = (raw ?? {}) as Record<string, unknown>;
    const char = letter.char;
    const chars = Array.from(
      typeof char === "string" || typeof char === "number" ? String(char) : "",
    );
    // Any one visible character: a sign may say R&D or ANDY'S, and a lone
    // character can't carry an instruction whatever it is. What's refused
    // is what can't be seen — whitespace, control characters, and the
    // zero-width and direction-switching ones that hide in \p{C}.
    if (chars.length !== 1 || /[\s\p{C}]/u.test(chars[0])) {
      throw new TypeError(
        `brief.letters[${i}].char must be one printable character`,
      );
    }
    return { char: chars[0], box: box(letter.box, `letters[${i}].box`) };
  });

  if (!Array.isArray(v.glass) || v.glass.length < 1 || v.glass.length > 12) {
    throw new TypeError("brief.glass must list 1 to 12 colors");
  }
  const glass = v.glass.map((c, i) => {
    const hex = String(c).toLowerCase();
    if (!HEX.test(hex))
      throw new TypeError(`brief.glass[${i}] must be #rrggbb`);
    return hex;
  });

  const targets = (v.targets ?? {}) as Record<string, unknown>;
  let map: StainedGlassBrief["map"] = null;
  if (v.map) {
    const m = v.map as Record<string, unknown>;
    if (!Array.isArray(m.rows) || m.rows.length > 24) {
      throw new TypeError("brief.map.rows must be at most 24 rows");
    }
    map = {
      cell: num(m.cell, "map.cell", 0.01, 1000),
      rows: m.rows.map((row, i) => {
        if (typeof row !== "string" || row.length > 160 || /[^#.]/.test(row)) {
          throw new TypeError(
            `brief.map.rows[${i}] must be up to 160 # and . characters`,
          );
        }
        return row;
      }),
    };
  }

  return {
    width: num(v.width, "width", 1, 5000),
    height: num(v.height, "height", 1, 5000),
    frameWidth: num(v.frameWidth, "frameWidth", 0.01, 500),
    leadWidth: num(v.leadWidth, "leadWidth", 0.01, 500),
    minFeature: num(v.minFeature, "minFeature", 0.01, 500),
    inner: box(v.inner, "inner"),
    band: v.band ? box(v.band, "band") : null,
    letters,
    glass,
    targets: {
      background: Math.round(
        num(targets.background, "targets.background", 1, 400),
      ),
      cuts: Math.round(num(targets.cuts, "targets.cuts", 0, 200)),
      perLetter: Math.round(num(targets.perLetter, "targets.perLetter", 1, 12)),
    },
    map,
  };
}

/**
 * The first whole `<svg>…</svg>` in a model's reply, with any code fence or
 * chatter around it dropped. Null when there isn't one, or when it was cut
 * short.
 *
 * One pass over the text, a tag at a time, so a reply written to waste a
 * server's time can't: comments are stepped over, a tag ends at its `>`
 * outside any quotes, and "the <svg below" in passing is a mention, not a
 * tag. A reply with a draft and a second attempt gives the draft alone.
 */
export function extractStainedGlassSvg(reply: string): string | null {
  const next = /<!--|<(\/?)([a-zA-Z][\w:-]*)/g;
  /** Where each `<svg` still waiting for its `</svg>` began. */
  const open: number[] = [];
  let best: [number, number] | null = null;
  for (let m = next.exec(reply); m; m = next.exec(reply)) {
    if (m[0] === "<!--") {
      const end = reply.indexOf("-->", m.index + 4);
      if (end < 0) break;
      next.lastIndex = end + 3;
      continue;
    }
    // To the end of this tag: the first `>` that isn't inside quotes
    let at = m.index + m[0].length;
    let quote = "";
    let end = -1;
    for (; at < reply.length; at++) {
      const c = reply[at];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") {
        end = at;
        break;
      } else if (c === "<") break;
    }
    if (end < 0) {
      // Ran into another `<` first: this one was prose. Off the end of the
      // text: nothing after it can be a tag either.
      if (at >= reply.length) break;
      next.lastIndex = at;
      continue;
    }
    next.lastIndex = end + 1;
    if (m[2].toLowerCase() !== "svg") continue;
    if (!m[1]) {
      if (reply[end - 1] !== "/") open.push(m.index);
      continue;
    }
    const start = open.pop();
    if (start === undefined) continue;
    // Nothing left open: this is the first drawing, whole
    if (open.length === 0) return reply.slice(start, end + 1);
    // Something before it never closed ("here is the <svg> you wanted").
    // Keep the earliest finished one, and let one that encloses it win.
    if (!best || start < best[0]) best = [start, end + 1];
  }
  return best ? reply.slice(best[0], best[1]) : null;
}
