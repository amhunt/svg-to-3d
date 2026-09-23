# svg-to-3d

Turns an SVG into watertight, multi-color solids your slicer will actually take,
and writes them out as a 3MF that opens flat on the plate with a filament slot
already on every color.

Extracted from the tool at [hunt.codes/svg-to-3d](https://www.hunt.codes/svg-to-3d),
where it turns flat vector art into multi-color prints.

## Install

```sh
npm install svg-to-3d three
```

three is a peer dep (≥ 0.185, where `ShapePath.toShapes()` picked up the
even-odd hole detection this leans on).

## Use

```ts
import {
  analyzeSvg,
  processAnalysis,
  exportToThreeMf,
  DEFAULT_PART_OPTIONS,
} from "svg-to-3d";

// Cheap — no geometry built, so it's fine to call while someone fiddles.
// Throws if the text isn't an SVG at all.
const analysis = analyzeSvg(svgText);
// { colors, shapesByColor, layers, skipped, document }

analysis.skipped;
// what no filament can print — { strokes, text, images, gradients, patterns,
// hidden, clipPaths, masks, translucent } — so you can say so

analysis.document.mmPerUnit;
// 0.1 for width="50mm" over a 500-unit viewBox; null when the file has no
// physical size and you have to ask

// Per color: depth in mm, optional chamfers.
const options = new Map(
  analysis.colors.map((c) => [
    c,
    { ...DEFAULT_PART_OPTIONS, extrudeDepth: 2.4 },
  ]),
);

// 0.5 converts SVG user units to mm.
const meshes = processAnalysis(analysis, 0.5, options);
// [{ color, vertices: Float32Array, triangles: Uint32Array, nonManifoldEdges, bevelFallbacks }]

const blob = await exportToThreeMf(meshes, "parts", { name: "rocket" });
```

Plain typed arrays out, so rendering is your business: Y up, the art in XZ,
resting on y = 0, the way three.js likes it. Colors come back canonical
(`#ff0000`, whatever the file spelled), in order of first appearance. Every
mesh reports `nonManifoldEdges` — it should be `0`, and it's a real check:
closed, and every face pointing out — plus `bevelFallbacks`, the polygons
whose chamfer didn't fit and went out square.

`"parts"` makes each color a part of one object so the slicer sees one model,
with color 1 on filament slot 1, color 2 on slot 2 and so on — load the AMS to
match and there's nothing to click. `"objects"` drops each color on the plate
separately, in a row, to print apart and glue up.

Overlaps are resolved the way they were painted: a white eye on a black head
with a black pupil on top comes out as a black part with an eye-shaped hole, a
white ring, and a black pupil, none of them intersecting. Pass
`{ flatten: false }` as a fourth argument to `processAnalysis` to get every
color over its full footprint instead — slicers let the later part cut into
the earlier ones, so that only works when nothing is painted on top of
anything.

## Why not just extrude it

| Instead of                                                  | What's left to write                                                                                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SVGLoader` + `ExtrudeGeometry`                             | everything. Fine for rendering, but the mesh isn't closed — unwelded vertices, same-color shapes left overlapping, doubled walls where two regions touch. Slicers reject it |
| [`@jscad/modeling`](https://github.com/jscad/OpenJSCAD.org) | real CSG in JS, but a general kernel — the color grouping, the repair and the 3MF are yours                                                                                 |
| [`manifold-3d`](https://github.com/elalish/manifold)        | genuinely guaranteed-manifold CSG, and still a kernel (in WASM) — same three things left over                                                                               |

Desktop gets there too — Inkscape → OpenSCAD, Blender's Solidify — but manually,
one color at a time, with nothing to call from a build.

This is the whole path instead, and the repair is the point: paths are cleaned
before triangulation, each color is boolean-unioned, everything gets welded,
coincident internal walls dissolve, T-junctions are split, and every solid is
eroded by ~0.5 µm so shapes meeting at a point come apart into separately
closed bodies instead of pinching. Chamfers only go on edges with air beside
them — a seam between two colors keeps its square corner rather than opening a
V-groove — and a chamfer that self-intersects falls back to a straight
extrusion rather than handing you something broken.

## In the slicer

The 3MF is Z-up with the base on the plate, carries a standard color group,
and ships `Metadata/model_settings.config` with a name and a filament slot per
part — the one bit of slicer-specific metadata both Bambu Studio and OrcaSlicer
actually read (their CLIs, 2.8 and 2.3, were the test bench; the standard
material extensions alone got every part filament 1). PrusaSlicer hasn't been
run against it yet.

## Notes

- Fills only. Strokes are dropped and counted in `skipped.strokes`; outline
  them first. Same for `<text>` (convert to paths) and `<image>`.
- Gradients flatten to their first stop, patterns are skipped, and both are
  counted. Partial opacity prints solid; `skipped.translucent` lists the colors.
- Hidden layers (`display:none`, `visibility="hidden"`, zero opacity) stay
  out. Masks and clip paths aren't applied — they're counted, except a clip to
  the whole canvas, which Figma puts on everything and changes nothing.
- 3MF only so far. STL is the obvious next one.
- In node, register a `DOMParser` before `analyzeSvg` (`@happy-dom/global-registrator`
  does it in one line). Everything after that is pure.

MIT
