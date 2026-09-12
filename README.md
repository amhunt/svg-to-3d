# svg-to-3d

Turns an SVG into watertight, multi-color solids your slicer will actually take,
and writes them out as a 3MF.

Extracted from the tool at [hunt.codes/svg-to-3d](https://hunt.codes/svg-to-3d),
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
const analysis = analyzeSvg(svgText); // { colors, shapesByColor }

// Per color: depth in mm, optional chamfers.
const options = new Map(
  analysis.colors.map((c) => [
    c,
    { ...DEFAULT_PART_OPTIONS, extrudeDepth: 2.4 },
  ]),
);

// 0.5 converts SVG user units to mm.
const meshes = processAnalysis(analysis, 0.5, options);
// [{ color, vertices: Float32Array, triangles: Uint32Array, nonManifoldEdges }]

const blob = await exportToThreeMf(meshes, "parts");
```

Plain typed arrays out, so rendering is your business. Every mesh reports
`nonManifoldEdges` — it should be `0`, and you can check rather than hope.
`"parts"` makes each color a part of one object so the slicer sees one model to
assign filaments to; `"objects"` drops each color on the plate separately, to
print apart and glue up.

## Why not just extrude it

| Instead of                                                  | What's left to write                                                                                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SVGLoader` + `ExtrudeGeometry`                             | everything. Fine for rendering, but the mesh isn't closed — unwelded vertices, same-color shapes left overlapping, doubled walls where two regions touch. Slicers reject it |
| [`@jscad/modeling`](https://github.com/jscad/OpenJSCAD.org) | real CSG in JS, but a general kernel — the color grouping, the repair and the 3MF are yours                                                                                 |
| [`manifold-3d`](https://github.com/elalish/manifold)        | genuinely guaranteed-manifold CSG, and still a kernel (in WASM) — same three things left over                                                                               |

Desktop gets there too — Inkscape → OpenSCAD, Blender's Solidify — but manually,
one color at a time, with nothing to call from a build.

This is the whole path instead, and the repair is the point: paths are cleaned before
triangulation, each color is boolean-unioned, everything gets welded, coincident
internal walls dissolve, T-junctions are split, and every solid is eroded by
~0.5 µm so shapes meeting at a point come apart into separately closed bodies
instead of pinching. Bevels that self-intersect fall back to a straight
extrusion rather than handing you something broken.

## Notes

- Fills only — strokes are ignored and `fill="none"` is skipped. Outline them first.
- No `<text>`; `SVGLoader` doesn't do it. Convert to paths.
- Flat colors — gradients and patterns aren't resolved.
- 3MF only so far. STL is the obvious next one.
- In node, register a `DOMParser` before `analyzeSvg` (`@happy-dom/global-registrator`
  does it in one line). Everything after that is pure.

MIT
