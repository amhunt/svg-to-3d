// The solid-building half of the library: clean 2D polygons in, welded
// watertight meshes out. Nothing here touches three or the DOM, so anything
// that can describe its artwork as polygons can use it.

import earcut from "earcut";
import type { Ring, Polygon, MultiPolygon } from "polygon-clipping";

export type ColorMesh = {
  /** Canonical `#rrggbb` fill color this part was built from. */
  color: string;
  /** What to call the part in the slicer's object list, when there's a better name than its color. */
  name?: string;
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

// ===========================================================================
// 2D polygon helpers
// ===========================================================================

export type Vec2 = { x: number; y: number };
export type CleanPoly = { outline: Vec2[]; holes: Vec2[][] };
export type BBox = { minX: number; minY: number; maxX: number; maxY: number };

export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}

export function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function ensureWinding(pts: Vec2[], wantCCW: boolean): Vec2[] {
  const isCCW = signedArea(pts) > 0;
  return isCCW === wantCCW ? pts : pts.slice().reverse();
}

export function bboxOf(pts: Vec2[]): BBox {
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

export function bboxOfMultiPolygon(mp: MultiPolygon): BBox {
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

export function bboxesOverlap(a: BBox, b: BBox): boolean {
  return (
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY
  );
}

export function pointInRing(p: Vec2, ring: Vec2[]): boolean {
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

export function pointInPoly(p: Vec2, poly: CleanPoly): boolean {
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
export function cleanPolygon(pts: Vec2[], eps: number): Vec2[] {
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
export function insetPolygon(
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

/** Erode every polygon by a sub-micron amount. A boolean union leaves regions
 * that touch at a single point still joined there; in 3D that pinch is a
 * non-manifold edge. Shrinking the solid by ~0.5µm opens those pinches into
 * separate, individually watertight solids without any visible change (a 1µm
 * gap is ~800× finer than a typical print nozzle). */
export const ERODE = 5e-4;

/** Anything smaller than this (mm²) is a boolean-op sliver, not artwork. */
export const MIN_AREA = 1e-4;

export function fromRings(poly: Polygon, eps: number): CleanPoly | null {
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
export function polysFromMultiPolygon(
  mp: MultiPolygon,
  eps: number,
): CleanPoly[] {
  const result: CleanPoly[] = [];
  for (const poly of mp) {
    const cp = fromRings(poly, eps);
    if (cp) result.push(cp);
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

export type Builder = {
  positions: number[];
  indices: number[];
};

export function pushVert(b: Builder, x: number, y: number, z: number): number {
  const i = b.positions.length / 3;
  b.positions.push(x, y, z);
  return i;
}

/** Triangulate a polygon-with-holes into a horizontal cap at height `y`. */
export function addCap(
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
export function addBand(
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
export type BevelEdges = {
  top: { outline: boolean[]; holes: boolean[][] } | null;
  bottom: { outline: boolean[]; holes: boolean[][] } | null;
};

/** Build the extruded solid for a single polygon (outline + holes). */
export function buildPolyGeometry(
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
export function buildManifoldPoly(
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

export type Neighbour = { poly: CleanPoly; bbox: BBox; top: number };

/** How far outside an edge to look for a neighbour (mm). */
export const PROBE = 0.02;

export function exposedEdges(
  ring: Vec2[],
  neighbours: Neighbour[],
  /** A neighbour has to reach above this height to cover the chamfer. */
  minTop: number,
): boolean[] {
  const n = ring.length;
  const out = new Array<boolean>(n);
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

export function bevelEdges(
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
export function weldAndClean(
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
export function dissolveInternalWalls(triangles: Uint32Array): Uint32Array {
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
export function repairTJunctions(
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
export function countNonManifoldEdges(triangles: Uint32Array): number {
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
// Parts → meshes
// ===========================================================================

/** One group of polygons that shares a color and a set of part options. */
export type SolidPart = {
  color: string;
  polys: CleanPoly[];
  options: PartOptions;
};

/**
 * Extrude every part and merge the results per color, in order of first
 * appearance. Two parts may share a color and still differ in depth — a
 * raised letter and the glass around it, say — and come back as one mesh.
 * Each polygon is welded and repaired independently before the merge.
 */
export function buildColorMeshes(parts: SolidPart[]): ColorMesh[] {
  // Everything a chamfer might run into.
  const allNeighbours: (Neighbour & { part: number })[] = [];
  parts.forEach((part, index) => {
    const top = Math.max(part.options.extrudeDepth, 0.01);
    for (const poly of part.polys) {
      allNeighbours.push({
        part: index,
        poly,
        bbox: bboxOf(poly.outline),
        top,
      });
    }
  });

  const byColor = new Map<
    string,
    { vertices: number[]; triangles: number[]; bevelFallbacks: number }
  >();
  parts.forEach((part, index) => {
    const opts = part.options;
    const wantsBevel =
      (opts.bevelTop || opts.bevelBottom) &&
      opts.bevelSize > 0 &&
      opts.bevelThickness > 0;
    const neighbours = wantsBevel
      ? allNeighbours.filter((nb) => nb.part !== index)
      : [];

    let merged = byColor.get(part.color);
    if (!merged) {
      merged = { vertices: [], triangles: [], bevelFallbacks: 0 };
      byColor.set(part.color, merged);
    }
    for (const poly of part.polys) {
      const edges: BevelEdges = wantsBevel
        ? bevelEdges(poly, opts, neighbours)
        : { top: null, bottom: null };
      const built = buildManifoldPoly(poly, opts, edges);
      if (built.bevelFallback) merged.bevelFallbacks++;
      const offset = merged.vertices.length / 3;
      for (let i = 0; i < built.vertices.length; i++) {
        merged.vertices.push(built.vertices[i]);
      }
      for (let i = 0; i < built.triangles.length; i++) {
        merged.triangles.push(built.triangles[i] + offset);
      }
    }
  });

  const result: ColorMesh[] = [];
  for (const [color, merged] of Array.from(byColor)) {
    // A color painted over entirely by later ones has nothing left to print.
    if (merged.triangles.length === 0) continue;
    const triangles = new Uint32Array(merged.triangles);
    result.push({
      color,
      vertices: new Float32Array(merged.vertices),
      triangles,
      nonManifoldEdges: countNonManifoldEdges(triangles),
      bevelFallbacks: merged.bevelFallbacks,
    });
  }
  return result;
}

/** Center the assembly in X/Z and rest it on the plate (minY = 0), in place. */
export function centerOnPlate(meshes: ColorMesh[]): ColorMesh[] {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const m of meshes) {
    const v = m.vertices;
    for (let i = 0; i < v.length; i += 3) {
      if (v[i] < minX) minX = v[i];
      if (v[i] > maxX) maxX = v[i];
      if (v[i + 1] < minY) minY = v[i + 1];
      if (v[i + 2] < minZ) minZ = v[i + 2];
      if (v[i + 2] > maxZ) maxZ = v[i + 2];
    }
  }
  if (!Number.isFinite(minX)) return meshes;
  const cx = (minX + maxX) / 2;
  const cy = minY;
  const cz = (minZ + maxZ) / 2;
  for (const m of meshes) {
    const v = m.vertices;
    for (let i = 0; i < v.length; i += 3) {
      v[i] -= cx;
      v[i + 1] -= cy;
      v[i + 2] -= cz;
    }
  }
  return meshes;
}
