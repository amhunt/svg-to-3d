// Every boolean and every offset the stained-glass path does goes through
// this file, so Clipper2 stays one import deep. Regions live in Clipper's
// integer space the whole way through the build (1 unit = 0.1 µm, the same
// grid the mesh welder snaps to) and only become millimetres at the ends.

import {
  ClipType,
  EndType,
  FillRule,
  JoinType,
  PolyTree64,
  areaPaths,
  booleanOpWithPolyTree,
  difference,
  inflatePaths,
  intersect,
  simplifyPath,
  union,
  type Path64,
  type Paths64,
  type PolyPath64,
} from "clipper2-ts";

import type { Vec2 } from "../solids.js";

/** Clipper units per millimetre. */
const UNITS = 1e4;
/** How far a rounded corner's chords may sit off the true arc, mm. */
const ARC_TOLERANCE = 0.005;

/** A set of closed paths: outlines one way round, holes the other. */
export type Region = Paths64;

/** One solid area: an outline and the holes in it. */
export type RegionPoly = { outline: Path64; holes: Path64[] };

const toPath = (ring: Vec2[], limit: number): Path64 => {
  const path: Path64 = [];
  for (const p of ring) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    path.push({
      x: Math.round(Math.min(limit, Math.max(-limit, p.x)) * UNITS),
      y: Math.round(Math.min(limit, Math.max(-limit, p.y)) * UNITS),
    });
  }
  return path;
};

/**
 * Rings in millimetres → a clean region, self-intersections and overlaps
 * resolved by the nonzero rule (what SVG fills and font outlines both use).
 * Coordinates are clamped to ±`limit` mm so that a shape drawn a kilometre
 * off the page can't push Clipper's integers past where they're exact.
 */
export function regionOf(rings: Vec2[][], limit: number): Region {
  const paths = rings.map((r) => toPath(r, limit)).filter((p) => p.length >= 3);
  return paths.length ? union(paths, FillRule.NonZero) : [];
}

export function rectRegion(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Region {
  if (!(x1 > x0) || !(y1 > y0)) return [];
  return regionOf(
    [
      [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ],
    ],
    1e5,
  );
}

export const unite = (a: Region, b: Region): Region =>
  a.length === 0 ? b : b.length === 0 ? a : union(a, b, FillRule.NonZero);

export const subtract = (a: Region, b: Region): Region =>
  a.length === 0 || b.length === 0 ? a : difference(a, b, FillRule.NonZero);

export const overlap = (a: Region, b: Region): Region =>
  a.length === 0 || b.length === 0 ? [] : intersect(a, b, FillRule.NonZero);

/**
 * Move a region's boundary outward by `mm` (inward when negative), with
 * round corners unless `square`, which keeps a rectangle a rectangle.
 */
export function grow(region: Region, mm: number, square = false): Region {
  if (region.length === 0 || mm === 0) return region;
  return inflatePaths(
    region,
    mm * UNITS,
    square ? JoinType.Miter : JoinType.Round,
    EndType.Polygon,
    2,
    ARC_TOLERANCE * UNITS,
  );
}

/** Open lines in millimetres → the region within `halfWidth` mm of them. */
export function strokeRegion(
  lines: Vec2[][],
  halfWidth: number,
  limit: number,
): Region {
  const paths = lines.map((l) => toPath(l, limit)).filter((p) => p.length >= 2);
  if (paths.length === 0) return [];
  const stroked = inflatePaths(
    paths,
    halfWidth * UNITS,
    JoinType.Round,
    EndType.Round,
    2,
    ARC_TOLERANCE * UNITS,
  );
  return stroked.length ? union(stroked, FillRule.NonZero) : [];
}

/** Area in mm². */
export const areaOf = (region: Region): number =>
  Math.abs(areaPaths(region)) / (UNITS * UNITS);

/**
 * A region as separate solid areas, each with its own holes. An island
 * inside a hole comes back as an area of its own.
 */
export function polygonsOf(region: Region): RegionPoly[] {
  if (region.length === 0) return [];
  const tree = new PolyTree64();
  booleanOpWithPolyTree(ClipType.Union, region, null, tree, FillRule.NonZero);
  const out: RegionPoly[] = [];
  const visit = (node: PolyPath64) => {
    for (let i = 0; i < node.count; i++) {
      const outer = node.child(i);
      if (!outer.polygon) continue;
      const poly: RegionPoly = { outline: outer.polygon, holes: [] };
      out.push(poly);
      for (let j = 0; j < outer.count; j++) {
        const hole = outer.child(j);
        if (hole.polygon) poly.holes.push(hole.polygon);
        visit(hole);
      }
    }
  };
  visit(tree);
  return out;
}

export const polyRegion = (poly: RegionPoly): Region => [
  poly.outline,
  ...poly.holes,
];

/** How far a finished outline may be straightened, mm. */
const SIMPLIFY = 0.004;

const tidyPath = (path: Path64): Path64 =>
  simplifyPath(path, SIMPLIFY * UNITS, true);

/**
 * Thin out a finished outline. An offset leaves a curve as hundreds of
 * points a few microns apart, each turning by almost nothing; the mesh
 * builder reads a run like that as a straight line and flattens the curve.
 * Keeping only the points that matter to within a few microns gives it
 * honest corners to work with, and changes nothing you could measure.
 */
export const tidy = (poly: RegionPoly): RegionPoly | null => {
  const outline = tidyPath(poly.outline);
  if (outline.length < 3) return null;
  return {
    outline,
    holes: poly.holes.map(tidyPath).filter((h) => h.length >= 3),
  };
};

export const polyArea = (poly: RegionPoly): number => areaOf(polyRegion(poly));

/** A Clipper path back in millimetres. */
export const pointsOf = (path: Path64): Vec2[] =>
  path.map((p) => ({ x: p.x / UNITS, y: p.y / UNITS }));

/** `[x0, y0, x1, y1]` of a path, in millimetres. */
export function boundsOf(path: Path64): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of path) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return [x0 / UNITS, y0 / UNITS, x1 / UNITS, y1 / UNITS];
}
