import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import type { Shape, Vector2 } from "three";
import earcut from "earcut";
import polygonClipping from "polygon-clipping";
import type { Pair, Ring, Polygon, MultiPolygon } from "polygon-clipping";

const CURVE_SEGMENTS = 24;

export type ColorMesh = {
  color: string;
  vertices: Float32Array;
  triangles: Uint32Array;
  nonManifoldEdges: number;
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

export type SvgAnalysis = {
  colors: string[];
  shapesByColor: Map<string, Shape[]>;
};

function normalizeColor(c: string | undefined | null): string {
  if (!c) return "#808080";
  const s = c.trim().toLowerCase();
  if (s === "none") return "none";
  return s;
}

/** Parse an SVG and group its filled shapes by color. Cheap — no geometry. */
export function analyzeSvg(svgText: string): SvgAnalysis {
  const loader = new SVGLoader();
  const data = loader.parse(svgText);

  const shapesByColor = new Map<string, Shape[]>();
  for (const path of data.paths) {
    const style = (path.userData as { style?: { fill?: string } } | undefined)
      ?.style;
    const color = normalizeColor(
      style?.fill ??
        (
          path as unknown as { color?: { getStyle(): string } }
        ).color?.getStyle(),
    );
    if (color === "none") continue;
    // toShapes() carries the even-odd hole detection; SVGLoader.createShapes
    // is a deprecated wrapper around it as of three r185.
    const shapes = path.toShapes();
    if (shapes.length === 0) continue;
    const list = shapesByColor.get(color) ?? [];
    list.push(...shapes);
    shapesByColor.set(color, list);
  }

  return { colors: Array.from(shapesByColor.keys()), shapesByColor };
}

// ===========================================================================
// 2D polygon helpers
// ===========================================================================

type Vec2 = { x: number; y: number };
type CleanPoly = { outline: Vec2[]; holes: Vec2[][] };

function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}

function ensureWinding(pts: Vec2[], wantCCW: boolean): Vec2[] {
  const isCCW = signedArea(pts) > 0;
  return isCCW === wantCCW ? pts : pts.slice().reverse();
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
 * Offset a polygon along its angle bisectors. `distance > 0` always reduces
 * the solid area: a CCW outline shrinks inward, a CW hole grows outward.
 */
function insetPolygon(pts: Vec2[], distance: number, ccw: boolean): Vec2[] {
  const n = pts.length;
  const out: Vec2[] = [];
  // Inward (toward solid material): CCW → rotate edge +90°, CW → rotate -90°.
  const s = ccw ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];

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

    const n1x = s * -e1y;
    const n1y = s * e1x;
    const n2x = s * -e2y;
    const n2y = s * e2x;

    let bx = n1x + n2x;
    let by = n1y + n2y;
    const bl = Math.hypot(bx, by) || 1;
    bx /= bl;
    by /= bl;

    // Distance along the bisector to achieve `distance` perpendicular offset.
    // Clamp to keep sharp corners from shooting off into long spikes.
    let cosA = bx * n1x + by * n1y;
    if (cosA < 0.2) cosA = 0.2;

    out.push({
      x: curr.x + (bx * distance) / cosA,
      y: curr.y + (by * distance) / cosA,
    });
  }
  return out;
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
  const toLocal = (pts: Vector2[]): Vec2[] =>
    // SVG has +Y down; negate Y so visual orientation survives into world XZ.
    pts.map((p) => ({ x: p.x * scale, y: -p.y * scale }));

  const toRing = (pts: Vec2[]): Ring => pts.map((p) => [p.x, p.y] as Pair);

  const geoms: MultiPolygon[] = [];
  for (const shape of shapes) {
    const ex = shape.extractPoints(CURVE_SEGMENTS);
    const outline = cleanPolygon(toLocal(ex.shape), eps);
    if (outline.length < 3) continue;
    const holes = (ex.holes ?? [])
      .map((h) => cleanPolygon(toLocal(h), eps))
      .filter((h) => h.length >= 3);
    geoms.push([[toRing(outline), ...holes.map(toRing)]]);
  }
  if (geoms.length === 0) return [];

  // Erode every polygon by a sub-micron amount. A boolean union leaves regions
  // that touch at a single point still joined there; in 3D that pinch is a
  // non-manifold edge. Shrinking the solid by ~0.5µm opens those pinches into
  // separate, individually watertight solids without any visible change (a 1µm
  // gap is ~800× finer than a typical print nozzle).
  const ERODE = 5e-4;

  const fromRings = (poly: Polygon): CleanPoly | null => {
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

    outline = cleanPolygon(insetPolygon(outline, ERODE, true), eps);
    if (outline.length < 3) return null;
    holes = holes
      .map((h) => cleanPolygon(insetPolygon(h, ERODE, false), eps))
      .filter((h) => h.length >= 3);

    return { outline, holes };
  };

  try {
    const unioned = polygonClipping.union(geoms[0], ...geoms.slice(1));
    const result: CleanPoly[] = [];
    for (const poly of unioned) {
      const cp = fromRings(poly);
      if (cp) result.push(cp);
    }
    return result;
  } catch {
    // If the boolean op fails, fall back to the raw (cleaned) shapes.
    const result: CleanPoly[] = [];
    for (const g of geoms) {
      const cp = fromRings(g[0]);
      if (cp) result.push(cp);
    }
    return result;
  }
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
  // A CCW outline yields +Y-facing triangles. Reverse for the bottom cap.
  for (let i = 0; i < idx.length; i += 3) {
    const a = baseIdx + idx[i];
    const c = baseIdx + idx[i + 1];
    const d = baseIdx + idx[i + 2];
    if (faceUp) b.indices.push(a, c, d);
    else b.indices.push(a, d, c);
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

/** Build the extruded solid for a single polygon (outline + holes). */
function buildPolyGeometry(
  poly: CleanPoly,
  opts: PartOptions,
): { vertices: number[]; triangles: number[] } {
  const b: Builder = { positions: [], indices: [] };
  const { outline, holes } = poly;

  const depth = Math.max(opts.extrudeDepth, 0.01);
  const hasBevel = opts.bevelSize > 0 && opts.bevelThickness > 0;
  const topBevel = opts.bevelTop && hasBevel;
  const botBevel = opts.bevelBottom && hasBevel;

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
    ? insetPolygon(outline, opts.bevelSize, true)
    : outline;
  const topHoles = topBevel
    ? holes.map((h) => insetPolygon(h, opts.bevelSize, false))
    : holes;
  const botOutline = botBevel
    ? insetPolygon(outline, opts.bevelSize, true)
    : outline;
  const botHoles = botBevel
    ? holes.map((h) => insetPolygon(h, opts.bevelSize, false))
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
): { vertices: Float32Array; triangles: Uint32Array } {
  const finish = (o: PartOptions) => {
    const raw = buildPolyGeometry(poly, o);
    const welded = weldAndClean(raw.vertices, raw.triangles);
    const dissolved = dissolveInternalWalls(welded.triangles);
    const triangles = repairTJunctions(welded.vertices, dissolved);
    return { vertices: welded.vertices, triangles };
  };

  const beveled = finish(opts);
  const wantsBevel = opts.bevelTop || opts.bevelBottom;
  if (wantsBevel && countNonManifoldEdges(beveled.triangles) > 0) {
    return finish({ ...opts, bevelTop: false, bevelBottom: false });
  }
  return beveled;
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

function countNonManifoldEdges(triangles: Uint32Array): number {
  // A closed manifold mesh has every edge shared by exactly 2 triangles.
  const edgeCounts = new Map<string, number>();
  for (let i = 0; i < triangles.length; i += 3) {
    const v = [triangles[i], triangles[i + 1], triangles[i + 2]];
    for (let j = 0; j < 3; j++) {
      const a = v[j];
      const b = v[(j + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const c of Array.from(edgeCounts.values())) if (c !== 2) bad++;
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
): ColorMesh[] {
  const result: ColorMesh[] = [];
  // Cleanup epsilon in mm, well below FDM print resolution.
  const eps = 1e-3;

  for (const [color, shapes] of Array.from(analysis.shapesByColor)) {
    const opts = optionsByColor.get(color) ?? DEFAULT_PART_OPTIONS;
    const polys = unionColorPolygons(shapes, scale, eps);

    // Each polygon is built, welded and repaired independently (erosion has
    // already separated them), then merged into the color's mesh.
    const mergedVerts: number[] = [];
    const mergedTris: number[] = [];
    for (const poly of polys) {
      const built = buildManifoldPoly(poly, opts);
      const offset = mergedVerts.length / 3;
      for (let i = 0; i < built.vertices.length; i++) {
        mergedVerts.push(built.vertices[i]);
      }
      for (let i = 0; i < built.triangles.length; i++) {
        mergedTris.push(built.triangles[i] + offset);
      }
    }

    const vertices = new Float32Array(mergedVerts);
    const triangles = new Uint32Array(mergedTris);
    result.push({
      color,
      vertices,
      triangles,
      nonManifoldEdges: countNonManifoldEdges(triangles),
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
    const cx = (minX + maxX) / 2;
    const cy = Number.isFinite(minY) ? minY : 0;
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

  return result;
}
