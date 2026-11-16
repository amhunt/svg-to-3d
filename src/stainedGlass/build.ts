import type { MultiPolygon, Pair } from "polygon-clipping";

import {
  DEFAULT_PART_OPTIONS,
  buildColorMeshes,
  centerOnPlate,
  polysFromMultiPolygon,
  type ColorMesh,
  type SolidPart,
  type Vec2,
} from "../solids.js";
import {
  areaOf,
  boundsOf,
  grow,
  overlap,
  pointsOf,
  polyArea,
  polyRegion,
  polygonsOf,
  rectRegion,
  regionOf,
  strokeRegion,
  subtract,
  tidy,
  unite,
  type Region,
  type RegionPoly,
} from "./clip.js";
import { parseDesign, type DesignRegion } from "./design.js";
import type { Box, StainedGlassLayout, StainedGlassWarning } from "./layout.js";

export type StainedGlassOptions = {
  /** Height of the glass, mm. Default 1.6. */
  thickness?: number;
  /** Height of the letters' glass, to stand them proud. Default `thickness`. */
  letterHeight?: number;
  /** Height of the lead and frame; lower it and the glass stands proud. Default `thickness`. */
  leadHeight?: number;
  /** Glass smaller than this, mm², is given to the lead. Default 4 × `minFeature`². */
  minPieceArea?: number;
  /**
   * Cut a lead line through any piece that completely surrounds another,
   * as a glazier has to, so the lead stays one connected part. Default true.
   */
  bridge?: boolean;
};

export type StainedGlassPiece = {
  /** `#rrggbb`, one of the layout's glass colors. */
  color: string;
  region: DesignRegion;
  /** mm² */
  area: number;
  box: Box;
};

export type StainedGlass = {
  /**
   * One mesh per color that has glass, lead first — so in the 3MF lead is
   * filament 1 and the glass colors follow in palette order.
   */
  meshes: ColorMesh[];
  /** The finished panel as a flat SVG in millimetres: one path per color. */
  svg: string;
  size: { width: number; height: number; thickness: number };
  pieces: StainedGlassPiece[];
  stats: {
    /** Share of the panel that's lead; the hand-made original is 0.32. */
    leadFraction: number;
    /** Pieces of glass by where they are. */
    letters: number;
    band: number;
    background: number;
    /** Pieces too small or thin to print, turned to lead. */
    dropped: number;
    /** Lead lines added to keep the lead in one part. */
    bridged: number;
  };
  warnings: StainedGlassWarning[];
};

const height = (
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

/** Paint thinner than this, mm, is two edges that nearly met, not a piece. */
const HAIRLINE = 0.1;

const rgbOf = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** "Redmean": cheap, and close enough to how far apart two colors look. */
const colorDistance = (a: string, b: string): number => {
  const [r1, g1, b1] = rgbOf(a);
  const [r2, g2, b2] = rgbOf(b);
  const mean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(
    (2 + mean / 256) * dr * dr +
      4 * dg * dg +
      (2 + (255 - mean) / 256) * db * db,
  );
};

const n3 = (n: number) => String(Math.round(n * 10000) / 10000);

const pathData = (polys: RegionPoly[]): string =>
  polys
    .flatMap((poly) => [poly.outline, ...poly.holes])
    .map(
      (path) =>
        `M${pointsOf(path)
          .map((p) => `${n3(p.x)} ${n3(p.y)}`)
          .join("L")}Z`,
    )
    .join("");

const toMultiPolygon = (polys: RegionPoly[]): MultiPolygon =>
  polys.map((poly) =>
    [poly.outline, ...poly.holes].map((path) =>
      pointsOf(path).map((p) => [p.x, p.y] as Pair),
    ),
  );

/** The two closest corners of two paths, one from each. */
const closestPair = (a: Vec2[], b: Vec2[]): [Vec2, Vec2] => {
  let best = Infinity;
  let pair: [Vec2, Vec2] = [a[0], b[0]];
  for (const p of a) {
    for (const q of b) {
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d < best) {
        best = d;
        pair = [p, q];
      }
    }
  }
  return pair;
};

/**
 * Turn a design into a panel: glass pieces, the lead between them, and the
 * meshes to print.
 *
 * The design only says what color goes where and where the glass is cut.
 * Every measurement comes from the layout: the frame is `frameWidth` wide,
 * two pieces that meet end up exactly `leadWidth` apart, and the letters'
 * glass is cut to the font's own outline, whatever was drawn. A gap that
 * is the font's own — the eye of an "e", the notch in an "N" — keeps the
 * font's width and fills with lead, never with more letter. Change a width in
 * the layout and build again with the same design to resize it.
 *
 * `designSvg` can be a model's reply to `stainedGlassPrompt`, the output
 * of `starterStainedGlass`, or something drawn by hand in the same form.
 * It throws only if that isn't SVG at all; a sloppy design — gaps,
 * overlaps, off-palette colors, shapes off the page — still builds, and
 * what had to be fixed is in `warnings`.
 */
export function buildStainedGlass(
  layout: StainedGlassLayout,
  designSvg: string,
  options: StainedGlassOptions = {},
): StainedGlass {
  const thickness = height(options.thickness, 1.6, "thickness");
  const letterHeight = height(options.letterHeight, thickness, "letterHeight");
  const leadHeight = height(options.leadHeight, thickness, "leadHeight");
  const { width: W, height: H } = layout.size;
  const lead = layout.leadWidth;
  const half = lead / 2;
  const feature = layout.minFeature;
  const minArea = options.minPieceArea ?? 4 * feature * feature;
  const limit = 4 * Math.max(W, H);
  const warnings: StainedGlassWarning[] = [];

  const design = parseDesign(designSvg);
  const box = design.viewBox ?? { x: 0, y: 0, width: W, height: H };
  const place = (p: Vec2): Vec2 => ({
    x: ((p.x - box.x) * W) / box.width,
    y: ((p.y - box.y) * H) / box.height,
  });

  const leadColor = layout.palette[0];
  const glass = layout.palette.slice(1);
  const base: Record<DesignRegion, string> = {
    letters: glass[0],
    band: glass[1 % glass.length],
    background: glass[2 % glass.length],
  };

  // Where each group's glass may be, exactly. Every zone's edge is an edge
  // of the finished glass, with lead beyond it: the frame outside the
  // glass area, one lead around the band, one lead around every letter.
  const inner = rectRegion(
    layout.frameWidth,
    layout.frameWidth,
    W - layout.frameWidth,
    H - layout.frameWidth,
  );
  // The letters as the font drew them. Nothing here grows an outline and
  // shrinks it back: that closes every gap narrower than the lead, which
  // fills the eye of an "e" and the bends of an "s" with glass.
  const ink = layout.letters.map((l) =>
    overlap(regionOf(l.rings, limit), inner),
  );
  const leaded = grow(ink.reduce(unite, [] as Region), lead);
  const b = layout.band;
  const bandBox = b
    ? overlap(rectRegion(b.x, b.y, b.x + b.width, b.y + b.height), inner)
    : [];
  const zones: Record<DesignRegion, Region[]> = {
    // One zone per letter, so two letters set tight never share a piece
    letters: ink,
    band: bandBox.length ? [subtract(bandBox, leaded)] : [],
    background: [
      subtract(inner, bandBox.length ? grow(bandBox, lead, true) : leaded),
    ],
  };

  let leadPaint = 0;
  let dropped = 0;
  let bridged = 0;
  const snap = (fill: string | null, region: DesignRegion): string | null => {
    if (fill === null) return base[region];
    let best = leadColor;
    let bestDistance = colorDistance(fill, leadColor);
    for (const color of glass) {
      const d = colorDistance(fill, color);
      if (d < bestDistance) {
        best = color;
        bestDistance = d;
      }
    }
    return best === leadColor ? null : best;
  };

  type Raw = {
    color: string;
    region: DesignRegion;
    /** Which of the region's zones it's in; pieces only meet within one */
    zone: number;
    poly: RegionPoly;
    box: [number, number, number, number];
  };
  const raw: Raw[] = [];
  const cuts: Record<DesignRegion, Region> = {
    letters: [],
    band: [],
    background: [],
  };

  for (const region of ["background", "band", "letters"] as const) {
    if (zones[region].length === 0) continue;

    // Painter's order, shape by shape: each keeps what nothing above it
    // covers. Two neighbours of one color stay two pieces — merging them
    // is how a window loses its leading.
    const paints: { color: string; shape: Region }[] = [
      { color: base[region], shape: rectRegion(-1, -1, W + 1, H + 1) },
    ];
    const lines: Vec2[][] = [];
    for (const shape of design.shapes) {
      if (shape.region !== region) continue;
      if (shape.kind === "cut") {
        lines.push(...shape.lines.map((line) => line.map(place)));
        continue;
      }
      const color = snap(shape.fill, region);
      if (color === null) {
        leadPaint++;
        continue;
      }
      const painted = regionOf(
        shape.rings.map((ring) => ring.map(place)),
        limit,
      );
      if (painted.length === 0) continue;
      // A fleck too small to leave any glass would still punch a hole in
      // whatever it was painted on, and print as a blob of lead. Leave it out.
      if (grow(painted, -(half + feature / 2)).length === 0) {
        dropped++;
        continue;
      }
      paints.push({ color, shape: painted });
    }
    cuts[region] = strokeRegion(lines, half, limit);

    let above: Region = [];
    const visible: { color: string; shape: Region }[] = [];
    for (let i = paints.length - 1; i >= 0; i--) {
      const shown = subtract(paints[i].shape, above);
      if (shown.length) visible.push({ color: paints[i].color, shape: shown });
      above = unite(above, paints[i].shape);
    }
    visible.reverse();

    zones[region].forEach((zone, z) => {
      for (const paint of visible) {
        for (const poly of polygonsOf(overlap(paint.shape, zone))) {
          // Two edges drawn a hair apart leave a hair of paint between
          // them. It isn't a piece and mustn't be treated as a neighbour.
          if (grow(polyRegion(poly), -HAIRLINE / 2).length === 0) continue;
          raw.push({
            color: paint.color,
            region,
            zone: z,
            poly,
            box: boundsOf(poly.outline),
          });
        }
      }
    });
  }

  // Glass is "opened": worn back by half the minimum feature and grown out
  // again, which takes off slivers, necks and strips too thin to print.
  // For the background and the band that is the whole of it, and it rounds
  // their corners a little. A letter would lose its corners that way, so a
  // letter keeps its own edge wherever the opened shape comes within half a
  // feature of it: square corners stay square, and a thin strip a cut left
  // hanging off a stroke still goes.
  type Piece = { color: string; region: DesignRegion; poly: RegionPoly };
  const pieces: Piece[] = [];
  const finish = (region: Region, exact: boolean): RegionPoly[] => {
    const opened = grow(grow(region, -feature / 2), feature / 2);
    const polys = polygonsOf(
      exact ? overlap(region, grow(opened, feature / 2)) : opened,
    );
    return polys.map(tidy).filter((p): p is RegionPoly => p !== null);
  };
  const keep = (source: Raw, polys: RegionPoly[]) => {
    for (const poly of polys) {
      if (polyArea(poly) < minArea) {
        dropped++;
        continue;
      }
      pieces.push({ color: source.color, region: source.region, poly });
    }
  };

  for (const piece of raw) {
    try {
      // Lead goes where two pieces meet, and only there. Each gives up
      // half a lead along the other, so the line between them is one lead
      // wide and centred on where they met; an edge with no neighbour —
      // the edge of the zone — stays exactly where it was drawn.
      const [x0, y0, x1, y1] = piece.box;
      const near: Region = [];
      for (const other of raw) {
        if (
          other === piece ||
          other.region !== piece.region ||
          other.zone !== piece.zone ||
          other.box[0] > x1 + half ||
          other.box[2] < x0 - half ||
          other.box[1] > y1 + half ||
          other.box[3] < y0 - half
        ) {
          continue;
        }
        near.push(...polyRegion(other.poly));
      }
      const exact = piece.region === "letters";
      const own = polyRegion(piece.poly);
      const trimmed = subtract(
        near.length ? subtract(own, grow(near, half)) : own,
        cuts[piece.region],
      );
      let polys = finish(trimmed, exact);
      if (polys.length === 0) {
        if (polyArea(piece.poly) > minArea) dropped++;
        continue;
      }
      // A piece that surrounds another leaves the lead between them cut
      // off from the rest. A glazier runs a lead out to the edge; so do we.
      if (options.bridge !== false) {
        for (
          let pass = 0;
          pass < 4 && polys.some((p) => p.holes.length > 0);
          pass++
        ) {
          const next: RegionPoly[] = [];
          for (const poly of polys) {
            if (poly.holes.length === 0) {
              next.push(poly);
              continue;
            }
            const outline = pointsOf(poly.outline);
            const struts: Vec2[][] = [];
            for (const hole of poly.holes) {
              const [from, to] = closestPair(pointsOf(hole), outline);
              const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
              const ux = ((to.x - from.x) / length) * lead;
              const uy = ((to.y - from.y) / length) * lead;
              struts.push([
                { x: from.x - ux, y: from.y - uy },
                { x: to.x + ux, y: to.y + uy },
              ]);
              bridged++;
            }
            next.push(
              ...finish(
                subtract(polyRegion(poly), strokeRegion(struts, half, limit)),
                exact,
              ),
            );
          }
          polys = next;
        }
      }
      keep(piece, polys);
    } catch {
      dropped++;
    }
  }

  // Lead is everything that isn't glass: the frame, and a line of exactly
  // one lead width wherever two pieces met.
  const panel = rectRegion(0, 0, W, H);
  let allGlass: Region = [];
  for (const piece of pieces)
    allGlass = unite(allGlass, polyRegion(piece.poly));
  const leadPolys = polygonsOf(subtract(panel, allGlass));
  const leadArea = leadPolys.reduce((sum, p) => sum + polyArea(p), 0);
  const leadFraction = leadArea / (W * H);

  // Parts: lead first so it takes filament slot 1, then glass in palette order.
  const eps = 1e-3;
  const partsFor = (
    polys: RegionPoly[],
    color: string,
    depth: number,
  ): SolidPart => ({
    color,
    polys: polysFromMultiPolygon(toMultiPolygon(polys), eps),
    options: { ...DEFAULT_PART_OPTIONS, extrudeDepth: depth },
  });
  const parts: SolidPart[] = [partsFor(leadPolys, leadColor, leadHeight)];
  const unused: string[] = [];
  for (const color of glass) {
    const mine = pieces.filter((p) => p.color === color);
    if (mine.length === 0) {
      unused.push(color);
      continue;
    }
    const letters = mine
      .filter((p) => p.region === "letters")
      .map((p) => p.poly);
    const rest = mine.filter((p) => p.region !== "letters").map((p) => p.poly);
    if (rest.length) parts.push(partsFor(rest, color, thickness));
    if (letters.length) parts.push(partsFor(letters, color, letterHeight));
  }
  const meshes = centerOnPlate(buildColorMeshes(parts));
  for (const mesh of meshes) {
    mesh.name =
      mesh.color === leadColor
        ? "Lead"
        : `Glass ${glass.indexOf(mesh.color) + 1}`;
  }

  // The same panel, flat.
  const fills = [
    `<path fill="${leadColor}" fill-rule="evenodd" d="${pathData(leadPolys)}"/>`,
  ];
  for (const color of glass) {
    const mine = pieces.filter((p) => p.color === color).map((p) => p.poly);
    if (mine.length)
      fills.push(
        `<path fill="${color}" fill-rule="evenodd" d="${pathData(mine)}"/>`,
      );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n3(W)} ${n3(H)}" width="${n3(W)}mm" height="${n3(H)}mm">${fills.join("")}</svg>`;

  const count = (region: DesignRegion) =>
    pieces.filter((p) => p.region === region).length;
  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  if (dropped > 0) {
    warnings.push({
      code: "dropped-pieces",
      message: `${plural(dropped, "piece was", "pieces were")} too small or too thin to print and became lead.`,
    });
  }
  if (bridged > 0) {
    warnings.push({
      code: "bridged",
      message: `${plural(bridged, "lead line was", "lead lines were")} added where one piece of glass surrounded another.`,
    });
  }
  if (leadPolys.length > 1) {
    warnings.push({
      code: "lead-islands",
      message: `The lead is in ${leadPolys.length} separate parts; the loose ones are held only by the glass around them.`,
    });
  }
  if (leadPaint > 0) {
    warnings.push({
      code: "lead-paint",
      message: `${plural(leadPaint, "shape was", "shapes were")} painted in the lead color and ignored; lead is added for you.`,
    });
  }
  if (unused.length > 0) {
    warnings.push({
      code: "unused-color",
      message: `${unused.join(", ")} ${unused.length === 1 ? "isn't" : "aren't"} used in this design, so the filament slots after ${unused.length === 1 ? "it" : "them"} move up.`,
    });
  }
  if (leadFraction > 0.5) {
    warnings.push({
      code: "too-much-lead",
      message: `${Math.round(leadFraction * 100)}% of the panel is lead. Fewer shards, thinner lead or a wider panel will let more light through.`,
    });
  }
  if (design.ignored.transforms > 0) {
    warnings.push({
      code: "ignored-transform",
      message:
        "The design uses transform, which isn't applied; shapes may be out of place.",
    });
  }
  if (design.ignored.truncated) {
    warnings.push({
      code: "design-truncated",
      message:
        "The design was too large and only the first part of it was used.",
    });
  }

  return {
    meshes,
    svg,
    size: {
      width: W,
      height: H,
      thickness: Math.max(thickness, letterHeight, leadHeight),
    },
    pieces: pieces.map((p) => {
      const [x0, y0, x1, y1] = boundsOf(p.poly.outline);
      return {
        color: p.color,
        region: p.region,
        area: polyArea(p.poly),
        box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
      };
    }),
    stats: {
      leadFraction,
      letters: count("letters"),
      band: count("band"),
      background: count("background"),
      dropped,
      bridged,
    },
    warnings,
  };
}
