# svg-to-3d

Turn an SVG into **watertight, multi-color solids** your slicer will actually accept.

`svg-to-3d` parses an SVG, groups its shapes by fill color, boolean-unions each
color into clean outlines, and extrudes them into manifold solids — then writes
the assembly out as a 3MF with one part per color, centered and resting on the
build plate, ready for filament assignment.

No upload, no desktop app, no repair round-trip. It runs in the browser and in
Node, in about 850 lines and three dependencies.

**[Live demo →](https://hunt.codes/svg-to-3d)**

```bash
npm install svg-to-3d three
```

## Quick start

```ts
import {
  analyzeSvg,
  processAnalysis,
  exportToThreeMf,
  DEFAULT_PART_OPTIONS,
} from "svg-to-3d";

const analysis = analyzeSvg(svgText);
// → { colors: ["#e4572e", "#17bebb"], shapesByColor: Map }

// Per-color settings: depth in mm, optional chamfers.
const options = new Map(
  analysis.colors.map((color) => [
    color,
    { ...DEFAULT_PART_OPTIONS, extrudeDepth: 2.4, bevelTop: true },
  ]),
);

const meshes = processAnalysis(analysis, 0.5, options);
// → [{ color, vertices: Float32Array, triangles: Uint32Array, nonManifoldEdges }]

for (const mesh of meshes) {
  console.assert(mesh.nonManifoldEdges === 0, `${mesh.color} is not closed`);
}

const blob = await exportToThreeMf(meshes, "parts");
```

`vertices`/`triangles` are plain typed arrays, so dropping the result into a
`THREE.BufferGeometry` (or anything else) is a two-line job — the library has no
opinion about how you render it.

## Why not just extrude it?

Extruding an SVG is easy. Extruding an SVG into something a **slicer** will take
without complaint is the hard part, and it's where every general-purpose tool
leaves you.

| Approach | Great at | Where it falls short here |
| --- | --- | --- |
| **three.js `SVGLoader` + `ExtrudeGeometry`** | The three-line answer everyone reaches for, and fine for rendering | Produces render-grade meshes: unwelded vertices, overlapping same-color shapes left overlapping, and no guarantee any of it is closed. Slicers flag the result as non-manifold |
| **Inkscape → OpenSCAD** (Paths to OpenSCAD) | Rock-solid CSG, a maker-community staple | Two desktop apps and a manual hop between them, single-color, slow on dense paths, and no way to call it from an app |
| **Blender** (SVG import + Solidify) | Beautiful results in skilled hands | GUI-driven and manual per file; getting to manifold is its own cleanup chore |
| **Online converters** (imagetostl, Vectary, et al.) | Zero setup | Upload your artwork to someone else's server, single color, no API to build on |
| **[`@jscad/modeling`](https://github.com/jscad/OpenJSCAD.org)** | Real programmatic CSG in JavaScript | A general CAD kernel, not a print pipeline — you bring the color grouping, the manifold repair and the 3MF writing yourself |
| **[`manifold-3d`](https://github.com/elalish/manifold)** | Excellent, genuinely guaranteed manifold CSG | A geometry kernel (WASM), not an SVG story. Still needs parsing, per-color union, triangulation and export around it |
| **Slicer SVG import** (Bambu Studio, PrusaSlicer) | Convenient for a one-off, right where you're printing | Interactive and per-model — nothing to script, embed, or run in a build |

**What this adds:** the whole path from `<svg>` to a slicer-ready 3MF, as one
library, with the manifold problem treated as the actual feature rather than an
afterthought.

## The manifold part

A mesh is printable when it's *closed*: every edge is shared by exactly two
triangles. Naive extrusion breaks that in several ways at once, so the pipeline
handles each one:

- **Path cleanup** — SVG exporters emit duplicate points, zero-length segments,
  and collinear spikes. These triangulate into zero-area slivers that become
  non-manifold edges the moment you weld. They're stripped first.
- **Per-color boolean union** — stained-glass-style art has many same-colored
  cells that touch or overlap, and individual paths are often self-intersecting.
  A union pass resolves all of it into proper outlines and holes.
- **Sub-micron erosion** — a union leaves regions that meet at a single point
  still joined there, which is a pinch (and non-manifold) in 3D. Shrinking each
  solid by ~0.5 µm opens those pinches into separately watertight bodies. That
  gap is roughly 800× finer than a typical nozzle, so nothing visible changes.
- **Welding** — coincident vertices are merged so adjacent triangles genuinely
  share indices, which is what 3MF's manifold check looks at.
- **Internal wall dissolution** — two touching regions each extrude their own
  wall along the shared edge, leaving it bordered by four triangles. Those
  coincident pairs are dropped, fusing the regions into one solid.
- **T-junction repair** — where a long cap edge meets subdivided neighboring
  geometry, the long edge ends up bordered by one triangle. Those triangles get
  split at every vertex lying on them.
- **Bevel fallback** — chamfer insets can self-intersect on features smaller
  than the bevel. When that happens the part quietly falls back to a straight
  extrusion instead of shipping you broken geometry.

Every mesh comes back with a `nonManifoldEdges` count, so you can **verify**
rather than hope. It should be `0`; the demo surfaces it in the UI, and the test
suite asserts it across holes, touching shapes, corner pinches and bevels.

## API

### `analyzeSvg(svgText): SvgAnalysis`

Parses and groups filled shapes by color. Cheap — no geometry is built, so it's
safe to call on every keystroke while someone picks settings.

```ts
type SvgAnalysis = { colors: string[]; shapesByColor: Map<string, Shape[]> };
```

### `processAnalysis(analysis, scale, optionsByColor): ColorMesh[]`

Builds the solids. `scale` converts SVG user units to millimetres.

```ts
type PartOptions = {
  extrudeDepth: number;    // mm
  bevelTop: boolean;
  bevelBottom: boolean;
  bevelSize: number;       // mm — horizontal inset of the chamfer
  bevelThickness: number;  // mm — vertical height of the chamfer
};

type ColorMesh = {
  color: string;
  vertices: Float32Array;  // xyz triples, Y up, model resting at y = 0
  triangles: Uint32Array;
  nonManifoldEdges: number;
};
```

Colors missing from `optionsByColor` fall back to `DEFAULT_PART_OPTIONS`. The
assembly is centered on X/Z with its base at `y = 0`.

### `exportToThreeMf(meshes, mode): Promise<Blob>`

Writes a 3MF package. `mode` is `"parts"` (every color is a part of one object —
the slicer sees a single model to assign filaments to) or `"objects"` (every
color is its own object on the plate, to print separately and glue up).

## Using it in Node

three's `SVGLoader` parses with `DOMParser`, which Node doesn't ship. Register
one before calling `analyzeSvg`:

```ts
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
```

`processAnalysis` and `exportToThreeMf` are pure and need no DOM.

## Limitations

- **Fills only.** Strokes are ignored, and `fill="none"` is skipped — convert
  strokes to outlines first.
- **No `<text>`.** three's `SVGLoader` doesn't rasterize text; convert to paths.
- **Flat colors.** Gradients and patterns aren't resolved to a fill.
- **3MF only** for now. An STL writer is the obvious next addition.
- Peer-depends on **three ≥ 0.185**, where `ShapePath.toShapes()` carries the
  even-odd hole detection this relies on.

## Credits

Extracted from the SVG-to-3D tool on [hunt.codes](https://hunt.codes/svg-to-3d),
where it's used to turn flat vector art into multi-color prints.

MIT
