// Where a glazier would cut a letter. Glass can't take an inside corner: a
// sheet scored round one cracks straight out of it. So every sharp inside
// corner of a letter gets a lead line, run across the stroke to the far
// side, and the letter comes apart into its strokes the way a hand-leaded
// sign does: an H into two stems and a bar, a T into a bar and a stem. A
// letter with a counter (O, A, D) is cut through the counter as well, so
// no ring of glass is left with lead trapped inside it.

import type { Vec2 } from "../solids.js";
import { pointsOf, regionOf } from "./clip.js";

/** Nonzero winding test, the rule font outlines are filled by. */
export const insideRings = (x: number, y: number, rings: Vec2[][]): boolean => {
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

const signedArea = (ring: Vec2[]): number => {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};

const ringLength = (ring: Vec2[]): number => {
  let l = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    l += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return l;
};

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Vec2): number => Math.hypot(v.x, v.y);
const unit = (v: Vec2): Vec2 => {
  const l = len(v) || 1;
  return { x: v.x / l, y: v.y / l };
};

/** The stroke width of anything long and thin: twice its area over its perimeter. */
export const strokeWidthOf = (rings: Vec2[][]): number => {
  const area = Math.abs(rings.reduce((sum, r) => sum + signedArea(r), 0));
  const perimeter = rings.reduce((sum, r) => sum + ringLength(r), 0);
  return perimeter > 0 ? (2 * area) / perimeter : 0;
};

/**
 * The point `reach` along the ring from vertex `i`, going forwards or back.
 * Measuring a corner between points a little way off, rather than between
 * neighbouring vertices, sees a slightly rounded corner whole and doesn't
 * mistake the hundred small turns of a curve for corners.
 */
function along(ring: Vec2[], i: number, reach: number, step: 1 | -1): Vec2 {
  const n = ring.length;
  let walked = 0;
  let at = ring[i];
  for (let k = 1; k < n; k++) {
    const next = ring[(((i + step * k) % n) + n) % n];
    const d = len(sub(next, at));
    if (walked + d >= reach) {
      const t = (reach - walked) / (d || 1);
      return { x: at.x + (next.x - at.x) * t, y: at.y + (next.y - at.y) * t };
    }
    walked += d;
    at = next;
  }
  return at;
}

type Corner = {
  at: Vec2;
  /** Along each of the two edges that meet here, pointing away from the corner. */
  edges: [Vec2, Vec2];
  turn: number;
  /** Which ring of the outline it's on */
  ring: number;
};

/** Sharp corners where the glyph's ink wraps more than half way round. */
function insideCorners(rings: Vec2[][], reach: number): Corner[] {
  const found: Corner[] = [];
  const probe = reach * 0.25;
  rings.forEach((ring, r) => {
    const n = ring.length;
    if (n < 3) return;
    const candidates: Corner[] = [];
    for (let i = 0; i < n; i++) {
      const v = ring[i];
      const back = unit(sub(along(ring, i, reach, -1), v));
      const ahead = unit(sub(along(ring, i, reach, 1), v));
      const cos = back.x * ahead.x + back.y * ahead.y;
      // The angle between the two edges, 180° on a straight run
      const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
      const turn = Math.PI - angle;
      if (turn < (40 * Math.PI) / 180) continue;
      // Which side is ink: a step into the narrow angle between the edges
      // lands outside the letter at an inside corner.
      const mid = unit({ x: back.x + ahead.x, y: back.y + ahead.y });
      const into = { x: v.x + mid.x * probe, y: v.y + mid.y * probe };
      if (insideRings(into.x, into.y, rings)) continue;
      candidates.push({ at: v, edges: [back, ahead], turn, ring: r });
    }
    // One corner per corner: a rounded one shows up as a run of vertices,
    // and the sharpest of them stands for it.
    candidates.sort((a, b) => b.turn - a.turn);
    for (const c of candidates) {
      if (found.some((f) => len(sub(f.at, c.at)) < reach * 1.5)) continue;
      found.push(c);
    }
  });
  return found;
}

/**
 * Does the segment run through the middle of the ink the whole way (ends
 * aside)? Ink close by on both sides, so a segment along the letter's own
 * edge doesn't count.
 */
function throughInk(a: Vec2, b: Vec2, rings: Vec2[][], side: number): boolean {
  const d = unit(sub(b, a));
  const n = { x: -d.y * side, y: d.x * side };
  for (let k = 1; k < 12; k++) {
    const t = k / 12;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (!insideRings(x + n.x, y + n.y, rings)) return false;
    if (!insideRings(x - n.x, y - n.y, rings)) return false;
  }
  return true;
}

/** From `from` along `dir` until the ink ends, or null past `max`. */
function castAcross(
  from: Vec2,
  dir: Vec2,
  rings: Vec2[][],
  max: number,
  step: number,
): Vec2 | null {
  let inInk = false;
  for (let d = step; d <= max; d += step) {
    const x = from.x + dir.x * d;
    const y = from.y + dir.y * d;
    const inside = insideRings(x, y, rings);
    if (inside) inInk = true;
    else if (inInk) return { x, y };
    else if (d > step * 3) return null;
  }
  return null;
}

/**
 * Lead lines that split one letter into the pieces a glazier would cut it
 * into, as open polylines in the letter's own coordinates. Each one runs a
 * little past the ink at both ends so it meets the lead around the letter.
 */
export function letterJoins(drawn: Vec2[][], leadWidth: number): Vec2[][] {
  // The outline as one clean shape: a font may draw a letter as strokes
  // laid over each other, and the corners that matter are where the
  // strokes' union turns, which no single contour shows.
  const rings = regionOf(drawn, 1e5).map(pointsOf);
  const stroke = strokeWidthOf(rings);
  if (!(stroke > 0)) return [];
  const reach = Math.max(stroke * 0.12, leadWidth * 0.25);
  const corners = insideCorners(rings, reach);
  const longest = stroke * 1.6;
  // Far enough past the ink to sever it, not so far it reaches the next
  // letter, which may sit just one lead away.
  const over = leadWidth * 0.3;
  const extend = (a: Vec2, b: Vec2): Vec2[] => {
    const d = unit(sub(b, a));
    return [
      { x: a.x - d.x * over, y: a.y - d.y * over },
      { x: b.x + d.x * over, y: b.y + d.y * over },
    ];
  };
  const cuts: Vec2[][] = [];

  // Two inside corners facing each other across a stroke share a cut: the
  // two notches under the bar of a T, the corners either side of an H's bar.
  const pairs: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      const d = len(sub(corners[i].at, corners[j].at));
      if (d > longest || d < leadWidth) continue;
      if (!throughInk(corners[i].at, corners[j].at, rings, stroke * 0.15)) {
        continue;
      }
      pairs.push({ i, j, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const used = new Set<number>();
  for (const { i, j } of pairs) {
    if (used.has(i) || used.has(j)) continue;
    used.add(i);
    used.add(j);
    cuts.push(extend(corners[i].at, corners[j].at));
  }

  // A corner on its own: the shortest way across the ink from it, looking
  // between carrying on one edge and carrying on the other. Carrying an
  // edge straight on reads best, so those win a near tie.
  corners.forEach((corner, i) => {
    if (used.has(i)) return;
    const [a, b] = corner.edges.map((e) => ({ x: -e.x, y: -e.y }));
    // From one continued edge round to the other, through the ink: the
    // ink lies the opposite way from the gap the two edges open onto.
    const gap = unit({
      x: corner.edges[0].x + corner.edges[1].x,
      y: corner.edges[0].y + corner.edges[1].y,
    });
    const ab = Math.atan2(a.y, a.x);
    let bb = Math.atan2(b.y, b.x);
    // Go round whichever way passes through -gap
    const away = Math.atan2(-gap.y, -gap.x);
    const norm = (t: number) =>
      ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (norm(away - ab) > norm(bb - ab)) bb -= 2 * Math.PI;
    let best: Vec2[] | null = null;
    let bestScore = Infinity;
    const STEPS = 8;
    for (let k = 0; k <= STEPS; k++) {
      const t = ab + ((bb - ab) * k) / STEPS;
      const dir = { x: Math.cos(t), y: Math.sin(t) };
      const end = castAcross(corner.at, dir, rings, longest, stroke / 40);
      if (!end) continue;
      const l = len(sub(end, corner.at));
      const score = k === 0 || k === STEPS ? l * 0.85 : l;
      if (score < bestScore) {
        bestScore = score;
        best = extend(corner.at, end);
      }
    }
    if (best) cuts.push(best);
  });

  // A counter (the hole in an O, A, D): cut straight up and down through it,
  // so the ring of glass round it comes apart and the lead inside it joins
  // the lead outside.
  const outerSign = Math.sign(
    rings.reduce(
      (best, r) =>
        Math.abs(signedArea(r)) > Math.abs(best) ? signedArea(r) : best,
      0,
    ),
  );
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const a = signedArea(ring);
    if (Math.sign(a) === outerSign || Math.abs(a) < leadWidth * leadWidth) {
      continue;
    }
    // A counter with sharp corners has been cut out from those already
    if (corners.some((c) => c.ring === r)) continue;
    let cx = 0;
    let cy = 0;
    for (const p of ring) {
      cx += p.x;
      cy += p.y;
    }
    cx /= ring.length;
    cy /= ring.length;
    if (insideRings(cx, cy, rings)) continue;
    for (const dir of [
      { x: 0, y: -1 },
      { x: 0, y: 1 },
    ]) {
      // From inside the counter, out through the ink above and below it
      let d = 0;
      while (d < stroke * 20 && !insideRings(cx, cy + dir.y * d, rings)) {
        d += stroke / 40;
      }
      const edge = { x: cx, y: cy + dir.y * d };
      const end = castAcross(
        { x: edge.x, y: edge.y - dir.y * (stroke / 40) },
        dir,
        rings,
        longest * 1.5,
        stroke / 40,
      );
      if (!end) continue;
      cuts.push(extend(edge, end));
    }
  }
  return cuts;
}
