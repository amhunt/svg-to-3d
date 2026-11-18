import type { Vec2 } from "../solids.js";
import {
  areaOf,
  grow,
  overlap,
  pointsOf,
  polygonsOf,
  polyRegion,
  rectRegion,
  regionOf,
  subtract,
  type Region,
} from "./clip.js";
import { insideRings } from "./joins.js";
import type { Box, StainedGlassLayout } from "./layout.js";

/**
 * The compositions `starterStainedGlass` can draw:
 *
 * - `"shards"`: the word's box carried out to the frame, and the glass
 *   around it broken up by gently curved cuts, each running from one lead
 *   line to the next. Like the hand-drawn sign this library was made for.
 * - `"border"`: a border of glass inside the frame with a jewel in each
 *   corner, and a field mitred out from the word's corners, symmetrical,
 *   in straight cuts. A house-number transom.
 * - `"halo"`: rings of glass round the word, each cut square to it into
 *   short rays, every other ring turned half a step. Art deco.
 */
export type StarterStyle = "shards" | "border" | "halo";

/** Every `StarterStyle`, in the order `seed` steps through them. */
export const STARTER_STYLES: readonly StarterStyle[] = [
  "border",
  "shards",
  "halo",
];

/** mulberry32: small, fast, and the same numbers on every machine. */
const random = (seed: number) => {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const n2 = (n: number) => String(Math.round(n * 100) / 100);

/** One piece of glass being drawn: its outline, and its color once it has one. */
type Piece = {
  region: Region;
  color?: string;
  /** Tried and failed to split; don't try it again. */
  done?: boolean;
  /** Part of the composition's skeleton, colored by the style itself. */
  fixed?: boolean;
};

type Shape = {
  area: number;
  centre: Vec2;
  /** Unit vector along the piece's longest way */
  axis: Vec2;
  /** Half its extent along `axis` and across it */
  long: number;
  short: number;
  perimeter: number;
};

/** Area, centroid and principal axis from the polygon's second moments. */
function shapeOf(region: Region): Shape | null {
  let A = 0,
    cx = 0,
    cy = 0,
    ixx = 0,
    iyy = 0,
    ixy = 0,
    perimeter = 0;
  const rings = region.map(pointsOf);
  for (const ring of rings) {
    for (let i = 0, n = ring.length; i < n; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % n];
      const c = p.x * q.y - q.x * p.y;
      A += c;
      cx += (p.x + q.x) * c;
      cy += (p.y + q.y) * c;
      ixx += (p.y * p.y + p.y * q.y + q.y * q.y) * c;
      iyy += (p.x * p.x + p.x * q.x + q.x * q.x) * c;
      ixy += (p.x * q.y + 2 * p.x * p.y + 2 * q.x * q.y + q.x * p.y) * c;
      perimeter += Math.hypot(q.x - p.x, q.y - p.y);
    }
  }
  A /= 2;
  if (Math.abs(A) < 1e-9) return null;
  cx /= 6 * A;
  cy /= 6 * A;
  // ∫y², ∫x², ∫xy about the centroid
  const yy = ixx / 12 - A * cy * cy;
  const xx = iyy / 12 - A * cx * cx;
  const xy = ixy / 24 - A * cx * cy;
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  let long = 0,
    short = 0;
  for (const ring of rings) {
    for (const p of ring) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      long = Math.max(long, Math.abs(dx * axis.x + dy * axis.y));
      short = Math.max(short, Math.abs(-dx * axis.y + dy * axis.x));
    }
  }
  return {
    area: Math.abs(A),
    centre: { x: cx, y: cy },
    axis,
    long,
    short,
    perimeter,
  };
}

/**
 * Splits pieces with lines. Everything about what makes a cut a good one
 * lives here: a cut runs from one lead line to another and stops there
 * (so lines meet in T's, never crossing), lands well clear of every other
 * junction, and leaves two pieces that are each wide enough to cut, not
 * too long for their width, and not much smaller than their neighbours.
 */
class Cutter {
  /** Where lead lines already meet, mm */
  junctions: Vec2[] = [];
  constructor(
    private readonly lead: number,
    private readonly limit: number,
    /** Smallest piece worth making, mm² */
    private readonly minArea: number,
    /** How close two junctions may be, mm */
    private readonly spacing: number,
  ) {}

  /** A cut line through `centre` along `dir`, bowed by `bow` mm, long enough to cross anything. */
  line(centre: Vec2, dir: Vec2, half: number, bow: number): Vec2[] {
    const n = { x: -dir.y, y: dir.x };
    const pts: Vec2[] = [];
    const STEPS = bow === 0 ? 1 : 16;
    for (let k = 0; k <= STEPS; k++) {
      const t = -1 + (2 * k) / STEPS;
      const off = bow * (1 - t * t);
      pts.push({
        x: centre.x + dir.x * half * t + n.x * off,
        y: centre.y + dir.y * half * t + n.y * off,
      });
    }
    // Carry each end straight on, along its own tangent, past everything
    const far = this.limit;
    const end = (a: Vec2, b: Vec2): Vec2 => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      return { x: b.x + (dx / l) * far, y: b.y + (dy / l) * far };
    };
    return [
      end(pts[1], pts[0]),
      ...pts,
      end(pts[pts.length - 2], pts[pts.length - 1]),
    ];
  }

  /** A cubic curve from `a` to `d`, carried straight on past both ends. */
  curve(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2[] {
    const pts: Vec2[] = [];
    for (let k = 0; k <= 24; k++) {
      const t = k / 24;
      const u = 1 - t;
      pts.push({
        x:
          u * u * u * a.x +
          3 * u * u * t * b.x +
          3 * u * t * t * c.x +
          t * t * t * d.x,
        y:
          u * u * u * a.y +
          3 * u * u * t * b.y +
          3 * u * t * t * c.y +
          t * t * t * d.y,
      });
    }
    const far = this.limit;
    const end = (p: Vec2, q: Vec2): Vec2 => {
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const l = Math.hypot(dx, dy) || 1;
      return { x: q.x + (dx / l) * far, y: q.y + (dy / l) * far };
    };
    return [
      end(pts[1], pts[0]),
      ...pts,
      end(pts[pts.length - 2], pts[pts.length - 1]),
    ];
  }

  /**
   * One long line across everything it meets, crossing other lines as it
   * goes: the sweeping lines a panel is drawn around. All or nothing —
   * if it would leave any bad piece, nothing is cut.
   */
  across(pieces: Piece[], line: Vec2[]): boolean {
    const plan: { piece: Piece; made: Region[]; ends: Vec2[] }[] = [];
    for (const piece of pieces) {
      if (piece.fixed) continue;
      const ends = this.ends(piece.region, line);
      if (ends.length === 0) continue;
      if (ends.length !== 2) return false;
      const [a, b] = this.sides(piece.region, line);
      const as = polygonsOf(a);
      const bs = polygonsOf(b);
      if (as.length !== 1 || bs.length !== 1) return false;
      const made = [polyRegion(as[0]), polyRegion(bs[0])];
      const parent = Cutter.stretch(piece.region);
      if (!made.every((r) => this.good(r, parent))) return false;
      plan.push({ piece, made, ends });
    }
    if (plan.length === 0) return false;
    for (const { piece, made, ends } of plan) {
      pieces.splice(
        pieces.indexOf(piece),
        1,
        ...made.map((region) => ({ region })),
      );
      this.junctions.push(...ends);
    }
    return true;
  }

  /** The two sides of `region` either side of `line`. */
  sides(region: Region, line: Vec2[]): [Region, Region] {
    const a = line[0];
    const b = line[line.length - 1];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const n = {
      x: (-(b.y - a.y) / l) * this.limit,
      y: ((b.x - a.x) / l) * this.limit,
    };
    const side = regionOf(
      [
        [
          ...line,
          { x: b.x + n.x, y: b.y + n.y },
          { x: a.x + n.x, y: a.y + n.y },
        ],
      ],
      this.limit * 4,
    );
    return [overlap(region, side), subtract(region, side)];
  }

  /** Where `line` enters and leaves `region`. */
  ends(region: Region, line: Vec2[]): Vec2[] {
    const rings = region.map(pointsOf);
    const found: Vec2[] = [];
    let was: boolean | null = null;
    // Walk the line in short steps, near the region only
    const [x0, y0, x1, y1] = bounds(rings);
    const pad = this.lead * 2;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.min(4000, Math.ceil(l / (this.lead / 4)));
      for (let k = 0; k <= steps; k++) {
        const x = a.x + ((b.x - a.x) * k) / steps;
        const y = a.y + ((b.y - a.y) * k) / steps;
        if (x < x0 - pad || x > x1 + pad || y < y0 - pad || y > y1 + pad) {
          if (was) found.push({ x, y });
          was = false;
          continue;
        }
        const inside = insideRings(x, y, rings);
        if (was !== null && inside !== was) found.push({ x, y });
        was = inside;
      }
    }
    return found;
  }

  /** How long and thin: a square scores 16, a 3:1 strip 21, 4:1 25. */
  static stretch(region: Region): number {
    const shape = shapeOf(region);
    return shape ? (shape.perimeter * shape.perimeter) / shape.area : Infinity;
  }

  /**
   * Wide enough everywhere, and not a long thin strip — or, cut from one
   * that already was, at least less of one.
   */
  good(region: Region, parent = 0): boolean {
    const area = areaOf(region);
    if (area < this.minArea) return false;
    if (Cutter.stretch(region) > Math.max(24, parent * 0.85)) return false;
    const r = this.lead * 1.25;
    const opened = areaOf(grow(grow(region, -r), r));
    return opened / area > 0.86;
  }

  /**
   * Split `region` along `line` if it makes a good cut: two good pieces,
   * crossing the region once, ending clear of other junctions.
   */
  split(region: Region, line: Vec2[], strict = true): Region[] | null {
    const [a, b] = this.sides(region, line);
    const as = polygonsOf(a);
    const bs = polygonsOf(b);
    if (as.length !== 1 || bs.length !== 1) return null;
    const ra = polyRegion(as[0]);
    const rb = polyRegion(bs[0]);
    const parent = Cutter.stretch(region);
    if (strict && (!this.good(ra, parent) || !this.good(rb, parent))) {
      return null;
    }
    const ends = this.ends(region, line);
    if (ends.length !== 2) return null;
    if (strict) {
      for (const e of ends) {
        for (const j of this.junctions) {
          if (Math.hypot(e.x - j.x, e.y - j.y) < this.spacing) return null;
        }
      }
    }
    this.junctions.push(...ends);
    return [ra, rb];
  }

  /** Cut along `line` wherever it crosses, however the pieces come out. */
  force(region: Region, line: Vec2[]): Region[] {
    const [a, b] = this.sides(region, line);
    this.junctions.push(...this.ends(region, line));
    return [...polygonsOf(a), ...polygonsOf(b)]
      .map(polyRegion)
      .filter((r) => areaOf(r) > this.lead * this.lead);
  }
}

const bounds = (rings: Vec2[][]): [number, number, number, number] => {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  }
  return [x0, y0, x1, y1];
};

const corners = (b: Box): Vec2[] => [
  { x: b.x, y: b.y },
  { x: b.x + b.width, y: b.y },
  { x: b.x + b.width, y: b.y + b.height },
  { x: b.x, y: b.y + b.height },
];

const boxRegion = (b: Box): Region =>
  rectRegion(b.x, b.y, b.x + b.width, b.y + b.height);

/**
 * Break pieces up until there are about `target` of them: always the
 * biggest one that will still take a cut, across its longest way, a
 * little off-centre and off-square so nothing looks ruled.
 */
function subdivide(
  pieces: Piece[],
  target: number,
  cutter: Cutter,
  rand: () => number,
  options: { bow: number; jitter: number },
): void {
  let guard = 0;
  while (pieces.length < target && guard++ < target * 4) {
    let best: Piece | null = null;
    let bestArea = 0;
    for (const p of pieces) {
      if (p.done || p.fixed) continue;
      // A little chance in the order, so equal pieces don't split in rows
      const a = areaOf(p.region) * (0.85 + 0.3 * rand());
      if (a > bestArea) {
        best = p;
        bestArea = a;
      }
    }
    if (!best) return;
    const shape = shapeOf(best.region);
    if (!shape) {
      best.done = true;
      continue;
    }
    let made: Region[] | null = null;
    for (let attempt = 0; attempt < 10 && !made; attempt++) {
      // Across the longest way: perpendicular to the axis, turned a little
      const turn = (rand() * 2 - 1) * options.jitter * (1 + attempt * 0.15);
      const across =
        Math.atan2(shape.axis.y, shape.axis.x) + Math.PI / 2 + turn;
      const dir = { x: Math.cos(across), y: Math.sin(across) };
      const shift = (rand() * 2 - 1) * 0.3 * shape.long;
      const centre = {
        x: shape.centre.x + shape.axis.x * shift,
        y: shape.centre.y + shape.axis.y * shift,
      };
      const bow = (rand() * 2 - 1) * options.bow * shape.short;
      made = cutter.split(
        best.region,
        cutter.line(centre, dir, shape.short * 1.2, bow),
      );
    }
    if (!made) {
      best.done = true;
      continue;
    }
    pieces.splice(
      pieces.indexOf(best),
      1,
      ...made.map((region) => ({ region })),
    );
  }
}

/** Which pieces share an edge, as lists of indexes. */
function neighbours(pieces: Piece[], lead: number): number[][] {
  const boxes = pieces.map((p) => bounds(p.region.map(pointsOf)));
  const grown = pieces.map((p) => grow(p.region, lead * 0.3));
  const out: number[][] = pieces.map(() => []);
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a[0] > b[2] + lead || b[0] > a[2] + lead) continue;
      if (a[1] > b[3] + lead || b[1] > a[3] + lead) continue;
      if (areaOf(overlap(grown[i], pieces[j].region)) > lead * lead) {
        out[i].push(j);
        out[j].push(i);
      }
    }
  }
  return out;
}

/**
 * Color what the style left uncolored: mostly `ground`, with about
 * `share` of the pieces picked out in `accents`, never two accents side
 * by side, and every accent used at least once if there's room.
 */
function colorPieces(
  pieces: Piece[],
  ground: string,
  accents: string[],
  share: number,
  lead: number,
  rand: () => number,
): void {
  const free = pieces.map((p, i) => (p.color ? -1 : i)).filter((i) => i >= 0);
  if (accents.length === 0) {
    for (const i of free) pieces[i].color = ground;
    return;
  }
  const near = neighbours(pieces, lead);
  const order = free
    .map((i) => ({ i, k: rand() }))
    .sort((a, b) => a.k - b.k)
    .map((o) => o.i);
  const want = Math.max(accents.length, Math.round(free.length * share));
  let used = 0;
  for (const i of order) {
    if (used >= want) break;
    const color = accents[used % accents.length];
    if (
      near[i].some(
        (j) =>
          pieces[j].color && pieces[j].color !== ground && !pieces[j].fixed,
      )
    )
      continue;
    if (near[i].some((j) => pieces[j].color === color)) continue;
    pieces[i].color = color;
    used++;
  }
  for (const i of free) pieces[i].color ??= ground;
}

/** A piece and its mirror image across x = `axis`. */
const mirror = (region: Region, axis: number): Region =>
  regionOf(
    region.map((ring) =>
      pointsOf(ring).map((p) => ({ x: 2 * axis - p.x, y: p.y })),
    ),
    1e5,
  );

/**
 * A design with no model behind it, in one of three compositions (see
 * `StarterStyle`). It's written in the same form a model is asked for, so
 * it goes straight into `buildStainedGlass` — use it as the first thing on
 * screen, as the fallback when a model's reply won't do, or as an example
 * to edit.
 *
 * Every piece is cut the way glass can be: lines meet in T's, never cross,
 * and stop at the next lead line; no piece is a sliver or a long taper.
 * `shards` sets how many pieces. Without a `style`, `seed` picks one, so
 * stepping through seeds steps through the styles. The same layout and
 * options always give the same design.
 */
export function starterStainedGlass(
  layout: StainedGlassLayout,
  options: { seed?: number; style?: StarterStyle } = {},
): string {
  const seed = options.seed ?? 1;
  const style =
    options.style ??
    STARTER_STYLES[
      (((seed - 1) % STARTER_STYLES.length) + STARTER_STYLES.length) %
        STARTER_STYLES.length
    ];
  if (!STARTER_STYLES.includes(style)) {
    throw new RangeError(`style must be one of ${STARTER_STYLES.join(", ")}`);
  }
  const rand = random(seed * 7919 + STARTER_STYLES.indexOf(style));
  const { width: W, height: H } = layout.size;
  const lead = layout.leadWidth;
  const glass = layout.palette.slice(1);
  const letterColor = glass[0];
  const bandColor = glass[1 % glass.length];
  const ground = glass[2 % glass.length];
  const band = layout.band;
  // Colors with no job of their own
  const extra = glass.slice(3);
  // Colors the background may pick out pieces in. With a word, the extra
  // colors (or, with none, the band's and the letters'); with no word,
  // everything but the ground, since nothing else will use them.
  const others = glass.filter((c) => c !== ground);
  const accents = band
    ? extra.length
      ? extra
      : others.slice(0, 2).reverse()
    : [...extra, ...others.filter((c) => !extra.includes(c))];

  const inner = layout.inner;
  const limit = 4 * Math.max(W, H);
  const target = Math.max(2, layout.targets.background);
  const innerArea =
    inner.width * inner.height - (band ? band.width * band.height : 0);
  const typical = innerArea / target;
  const cutter = new Cutter(
    lead,
    limit,
    Math.max(9 * lead * lead, typical * 0.22),
    Math.max(2.5 * lead, Math.min(4 * lead, Math.sqrt(typical) * 0.35)),
  );
  const insideBox = boxRegion(inner);
  const field = band ? subtract(insideBox, boxRegion(band)) : insideBox;
  cutter.junctions.push(...corners(inner));
  if (band) cutter.junctions.push(...corners(band));

  let pieces: Piece[];
  if (style === "shards") pieces = shards();
  else if (style === "border") pieces = border();
  else pieces = halo();

  /** The word's box carried out to the frame, then curved cuts. */
  function shards(): Piece[] {
    let regions: Region[] = [field];
    if (band) {
      // The band's ends run on to the frame top and bottom, as in the sign
      // this was drawn from; only where there's room for glass beside it.
      const room = 3 * lead;
      for (const x of [band.x, band.x + band.width]) {
        if (x - inner.x < room || inner.x + inner.width - x < room) continue;
        const line = cutter.line({ x, y: H / 2 }, { x: 0, y: 1 }, H, 0);
        regions = regions.flatMap((r) => cutter.force(r, line));
      }
    }
    const out: Piece[] = regions.map((region) => ({ region }));
    // A few long sweeping lines first, edge to edge behind the word,
    // crossing each other where they must
    const x0 = inner.x;
    const x1 = inner.x + inner.width;
    const y0 = inner.y;
    const y1 = inner.y + inner.height;
    const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
    const sweeps = Math.max(1, Math.min(5, Math.round(target / 9)));
    let made = 0;
    for (let tries = 0; tries < 40 && made < sweeps; tries++) {
      const kind = rand();
      let line: Vec2[];
      if (kind < 0.45) {
        // Across, left to right, drifting
        const ya = between(y0, y1);
        const yb = between(y0, y1);
        line = cutter.curve(
          { x: x0, y: ya },
          { x: x0 + inner.width / 3, y: between(y0, y1) },
          { x: x0 + (2 * inner.width) / 3, y: between(y0, y1) },
          { x: x1, y: yb },
        );
      } else if (kind < 0.75) {
        // Down, top to bottom, leaning
        const xa = between(x0, x1);
        const xb = xa + between(-0.25, 0.25) * inner.width;
        line = cutter.curve(
          { x: xa, y: y0 },
          {
            x: xa + between(-0.1, 0.1) * inner.width,
            y: y0 + inner.height / 3,
          },
          {
            x: xb + between(-0.1, 0.1) * inner.width,
            y: y0 + (2 * inner.height) / 3,
          },
          { x: xb, y: y1 },
        );
      } else {
        // Corner to corner across one end of the panel
        const left = rand() < 0.5;
        const xs = left ? x0 : x1;
        const top = {
          x: xs + (left ? 1 : -1) * between(0.15, 0.45) * inner.width,
          y: y0,
        };
        const side = { x: xs, y: between(0.5, 1) * inner.height + y0 };
        line = cutter.curve(
          top,
          {
            x: (top.x * 2 + side.x) / 3,
            y: (top.y * 2 + side.y) / 3 + between(-0.15, 0.15) * inner.height,
          },
          { x: (top.x + side.x * 2) / 3, y: (top.y + side.y * 2) / 3 },
          side,
        );
      }
      if (cutter.across(out, line)) made++;
    }
    subdivide(out, target, cutter, rand, { bow: 0.18, jitter: 0.9 });
    colorPieces(out, ground, accents, 0.22, lead, rand);
    return out;
  }

  /**
   * A border of glass inside the frame, corner jewels, and a field mitred
   * from the word's corners. Drawn on the left and mirrored.
   */
  function border(): Piece[] {
    const centre = inner.x + inner.width / 2;
    const margin = band
      ? Math.min(band.x - inner.x, band.y - inner.y)
      : Math.min(inner.width, inner.height) * 0.3;
    const strip = Math.min(
      margin * 0.4,
      Math.min(inner.width, inner.height) * 0.14,
    );
    const room = strip >= 3.2 * lead && margin - strip >= 3.5 * lead;
    const out: Piece[] = [];
    const left = rectRegion(
      inner.x - 1,
      inner.y - 1,
      centre,
      inner.y + inner.height + 1,
    );
    let fieldBox = inner;
    if (room) {
      fieldBox = {
        x: inner.x + strip,
        y: inner.y + strip,
        width: inner.width - 2 * strip,
        height: inner.height - 2 * strip,
      };
      // Corner jewels, and the strip between them cut into equal lengths,
      // an odd number of them so the middle one sits on the centre line.
      const along = (length: number) => {
        const n = Math.max(1, Math.round(length / (strip * 2.6)));
        return n % 2 === 0 ? n + 1 : n;
      };
      const xs = inner.x + strip;
      const xe = inner.x + inner.width - strip;
      const ys = inner.y + strip;
      const ye = inner.y + inner.height - strip;
      const nx = along(xe - xs);
      const ny = along(ye - ys);
      const stripPieces: { r: Region; corner: boolean; k: number }[] = [];
      for (const [cx, cy] of [
        [inner.x, inner.y],
        [inner.x + inner.width - strip, inner.y],
        [inner.x, inner.y + inner.height - strip],
        [inner.x + inner.width - strip, inner.y + inner.height - strip],
      ]) {
        stripPieces.push({
          r: rectRegion(cx, cy, cx + strip, cy + strip),
          corner: true,
          k: 0,
        });
      }
      for (let i = 0; i < nx; i++) {
        const x0 = xs + ((xe - xs) * i) / nx;
        const x1 = xs + ((xe - xs) * (i + 1)) / nx;
        stripPieces.push({
          r: rectRegion(x0, inner.y, x1, ys),
          corner: false,
          k: i,
        });
        stripPieces.push({
          r: rectRegion(x0, ye, x1, inner.y + inner.height),
          corner: false,
          k: i,
        });
      }
      for (let i = 0; i < ny; i++) {
        const y0 = ys + ((ye - ys) * i) / ny;
        const y1 = ys + ((ye - ys) * (i + 1)) / ny;
        stripPieces.push({
          r: rectRegion(inner.x, y0, xs, y1),
          corner: false,
          k: i,
        });
        stripPieces.push({
          r: rectRegion(xe, y0, inner.x + inner.width, y1),
          corner: false,
          k: i,
        });
      }
      const jewel = glass.length > 1 ? letterColor : ground;
      const stripA = extra[0] ?? bandColor;
      const stripB = extra[1] ?? ground;
      for (const s of stripPieces) {
        out.push({
          region: s.r,
          fixed: true,
          color: s.corner ? jewel : s.k % 2 === 0 ? stripA : stripB,
        });
      }
    }
    // The field, mitred from the word's corners to its own: four
    // trapezoids, like a picture frame round the word. Left half only.
    let regions: Region[];
    cutter.junctions.push(...corners(fieldBox));
    if (band) {
      const f = corners(fieldBox);
      const w = corners(band);
      regions = [0, 1, 2, 3]
        .map((k) =>
          regionOf([[f[k], f[(k + 1) % 4], w[(k + 1) % 4], w[k]]], limit),
        )
        .flatMap((r) => polygonsOf(overlap(r, left)).map(polyRegion))
        .filter((r) => areaOf(r) > 4 * lead * lead);
    } else {
      regions = [overlap(boxRegion(fieldBox), left)];
    }
    const half: Piece[] = regions.map((region) => ({ region }));
    const fieldTarget = Math.max(regions.length * 3, Math.round(target * 0.7));
    subdivide(half, Math.ceil(fieldTarget / 2), cutter, rand, {
      bow: 0,
      jitter: 0.25,
    });
    colorPieces(half, ground, accents, 0.25, lead, rand);
    for (const p of half) {
      out.push(p);
      out.push({ region: mirror(p.region, centre), color: p.color });
    }
    return out;
  }

  /** Rings round the word, each cut into rays, symmetrical about the middle. */
  function halo(): Piece[] {
    const middle = band
      ? { x: band.x + band.width / 2, y: band.y + band.height / 2 }
      : { x: inner.x + inner.width / 2, y: inner.y + inner.height / 2 };
    const sun = Math.min(inner.width, inner.height) * 0.16;
    const core: Region = band
      ? boxRegion(band)
      : grow(
          rectRegion(
            middle.x - 0.01,
            middle.y - 0.01,
            middle.x + 0.01,
            middle.y + 0.01,
          ),
          sun,
        );
    const out: Piece[] = [];
    const coreColor = letterColor !== ground ? letterColor : bandColor;
    if (!band) out.push({ region: core, fixed: true, color: coreColor });
    // The colors that alternate with the ground in the rings, in turn
    const lights = band
      ? extra.length
        ? extra
        : [bandColor !== ground ? bandColor : accents[0]]
      : others.filter((c) => c !== coreColor);
    if (lights.length === 0) lights.push(ground);
    // How far the frame's farthest corner is from the core
    const reach = Math.max(
      ...corners(inner).map((c) =>
        band
          ? Math.hypot(
              Math.max(0, Math.abs(c.x - middle.x) - band.width / 2),
              Math.max(0, Math.abs(c.y - middle.y) - band.height / 2),
            )
          : Math.hypot(c.x - middle.x, c.y - middle.y) - sun,
      ),
    );
    const count = layout.shards <= 3 ? 1 : layout.shards <= 7 ? 2 : 3;
    const annuli: Region[] = [];
    let within = core;
    for (let k = 1; k <= count; k++) {
      // Rings widen going out, like ripples
      const ring = grow(core, reach * Math.pow(k / (count + 1), 1.2) * 0.85);
      annuli.push(overlap(subtract(ring, within), insideBox));
      within = ring;
    }
    annuli.push(subtract(insideBox, within));
    // Ray ends spaced evenly round the frame, from the top middle clockwise
    const perimeter = 2 * (inner.width + inner.height);
    const atPerimeter = (u: number): Vec2 => {
      let t =
        (((inner.width / 2 + u * perimeter) % perimeter) + perimeter) %
        perimeter;
      if (t < inner.width) return { x: inner.x + t, y: inner.y };
      t -= inner.width;
      if (t < inner.height) return { x: inner.x + inner.width, y: inner.y + t };
      t -= inner.height;
      if (t < inner.width)
        return { x: inner.x + inner.width - t, y: inner.y + inner.height };
      t -= inner.width;
      return { x: inner.x, y: inner.y + inner.height - t };
    };
    const areas = annuli.map(areaOf);
    annuli.forEach((annulus, k) => {
      if (areas[k] < 4 * lead * lead) return;
      // An even number of rays keeps it symmetrical; every other ring is
      // turned half a ray so no two rays meet across a ring.
      // The same number of rays in every ring, so they read as rays
      // Round a word, rays leave its edges square and every ring can take
      // as many. Round a sun they meet at its middle, so the inner rings
      // take fewer, or they'd taper to slivers.
      const full = Math.max(8, Math.round(target * 0.6));
      let n = band
        ? full
        : Math.max(6, Math.round((full * (k + 1)) / annuli.length));
      if (n % 2) n++;
      const turned = k % 2 === 1 ? 0.5 : 0;
      // Light alternating with the ground near the word, plain ground at
      // the edge. Never the letters' color next to the letters.
      for (let i = 0; i < n; i++) {
        const u0 = (i + turned) / n;
        const u1 = (i + 1 + turned) / n;
        // Each ray leaves the word square to its edge, fanning out only
        // round its corners: the ray's foot is the nearest point of the
        // word's box (or the sun's disc) to where it meets the frame.
        const foot = (p: Vec2): Vec2 => {
          if (band) {
            return {
              x: Math.min(band.x + band.width, Math.max(band.x, p.x)),
              y: Math.min(band.y + band.height, Math.max(band.y, p.y)),
            };
          }
          const l = Math.hypot(p.x - middle.x, p.y - middle.y) || 1;
          return {
            x: middle.x + ((p.x - middle.x) * sun) / l,
            y: middle.y + ((p.y - middle.y) * sun) / l,
          };
        };
        const feet: Vec2[] = [];
        const tips: Vec2[] = [];
        for (let q = 0; q <= 12; q++) {
          const p = atPerimeter(u0 + ((u1 - u0) * q) / 12);
          const f = foot(p);
          feet.push(f);
          // Well past the frame, so the wedge covers it
          const dx = p.x - f.x;
          const dy = p.y - f.y;
          const l = Math.hypot(dx, dy) || 1;
          tips.push({ x: p.x + (dx / l) * 10, y: p.y + (dy / l) * 10 });
        }
        const pts = [...feet, ...tips.reverse()];
        const wedge = regionOf([pts], limit);
        for (const poly of polygonsOf(overlap(annulus, wedge))) {
          const region = polyRegion(poly);
          if (areaOf(region) < 4 * lead * lead) continue;
          // Count out from the top middle both ways round, so the colors
          // are as symmetrical as the rays
          const u = (i + 0.5 + turned) / n;
          const m = Math.min(u, 1 - u) * n;
          const j = turned ? Math.round(m) : Math.round(m - 0.5);
          const lit = k < annuli.length - 1 && (j + k) % 2 === 0;
          out.push({
            region,
            color: lit ? lights[Math.floor(j / 2) % lights.length] : ground,
            fixed: true,
          });
        }
      }
    });
    return out;
  }

  // Any color still unused would leave its filament slot empty and move
  // every later one up: give it a few ground pieces, none touching another
  // piece of its color.
  const unused = glass.filter(
    (c) =>
      !pieces.some((p) => p.color === c) &&
      !(band && (c === letterColor || c === bandColor)),
  );
  if (unused.length) {
    const near = neighbours(pieces, lead);
    for (const color of unused) {
      let given = 0;
      for (let i = 0; i < pieces.length && given < 2; i++) {
        if (pieces[i].color !== ground) continue;
        if (near[i].some((j) => pieces[j].color === color)) continue;
        pieces[i].color = color;
        given++;
      }
    }
  }

  const paths = pieces
    .filter((p) => p.color)
    .map((p) => {
      const d = p.region
        .map(pointsOf)
        .map(
          (ring) => `M${ring.map((q) => `${n2(q.x)} ${n2(q.y)}`).join(" L")} Z`,
        )
        .join(" ");
      return `<path fill="${p.color}" d="${d}"/>`;
    });

  const bandShapes: string[] = [];
  const letterShapes: string[] = [];
  if (band) {
    const rect = (fill: string) =>
      `<rect x="${n2(band.x - 2)}" y="${n2(band.y - 2)}" width="${n2(band.width + 4)}" height="${n2(band.height + 4)}" fill="${fill}"/>`;
    bandShapes.push(rect(bandColor));
    letterShapes.push(rect(letterColor));
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n2(W)} ${n2(H)}"><g id="background"><rect x="0" y="0" width="${n2(W)}" height="${n2(H)}" fill="${ground}"/>${paths.join("")}</g><g id="band">${bandShapes.join("")}</g><g id="letters">${letterShapes.join("")}</g></svg>`;
}
