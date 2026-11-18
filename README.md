# svg-to-3d

Turns an SVG into watertight, multi-color solids your slicer will actually take,
and writes them out as a 3MF that opens flat on the plate with a filament slot
already on every color.

Extracted from the tool at [hunt.codes/svg-to-3d](https://www.hunt.codes/svg-to-3d),
where it turns flat vector art into multi-color prints. It also makes
[stained glass signs](#stained-glass-signs) out of a word and a font.

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

## Stained glass signs

Type a word, get a stained-glass panel: the word in glass, a background of
shards, lead between every piece and a frame around the lot.

```ts
import { parse } from "opentype.js";
import {
  layoutStainedGlass,
  starterStainedGlass,
  buildStainedGlass,
  exportToThreeMf,
} from "svg-to-3d";

const font = parse(
  await (await fetch("/fonts/Righteous-Regular.ttf")).arrayBuffer(),
);

// 1. Measure it out. The word sets the proportions; `width` sets the size.
const layout = layoutStainedGlass({ text: "HUNT", font, width: 250 });
layout.size; // { width: 250, height: 123.8 }

// 2. A design: which color goes where, and where the glass is cut.
// "border", "shards" or "halo"; leave the style out and the seed picks one.
const design = starterStainedGlass(layout, { style: "border", seed: 7 });

// 3. Glass, lead and meshes.
const glass = buildStainedGlass(layout, design);
glass.svg; // the panel, flat, in mm
glass.pieces; // [{ color, region: "letters" | "band" | "background", area, box }]
glass.warnings; // [{ code, message }] — what had to be fixed, in plain words

const blob = await exportToThreeMf(glass.meshes, "parts", { name: "hunt" });
```

Nothing in that needs a DOM: the library runs as it is in Node, a Web
Worker or an edge function. (The font is the one line to change for Node,
where opentype.js loads as CommonJS: `import opentype from "opentype.js"`,
then `opentype.parse` on a buffer read with `fs`.) Import from
`svg-to-3d/stained-glass` instead of the root and three isn't loaded either. Fonts come in as anything with
`unitsPerEm` and `stringToGlyphs` — an opentype.js font fits — so the
library doesn't ship a font parser you might not want.

### The design draws, the library measures

A design is a small SVG that only says what's painted where. It never
draws lead, a frame or a letter:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 123.8">
  <g id="background">
    <rect width="250" height="123.8" fill="#3c8dea"/>
    <path d="M0 123.8 L0 70 C80 40 160 90 250 50 L250 123.8 Z" fill="#fdbc00"/>
    <path fill="none" stroke="#000" d="M-10 20 C80 60 170 -10 260 40"/>
  </g>
  <g id="band"><rect x="30" y="30" width="190" height="60" fill="#fdbc00"/></g>
  <g id="letters"><rect x="30" y="30" width="190" height="60" fill="#cd000e"/></g>
</svg>
```

- **Paint** is any filled shape. Later shapes cover earlier ones, and two
  shapes that meet become two pieces of glass with lead between them, even
  in the same color.
- **Cuts** are paths with `fill="none"` and a stroke: lines where glass is
  split. Only where the line runs matters; its width is the lead's.
- `background` is the glass around the word, `band` the box the word sits
  in (what shows between the letters and inside an O), `letters` what
  shows inside the letterforms themselves.

`buildStainedGlass` takes that and does the measuring. Whatever the design
drew:

- the frame is exactly `frameWidth` wide and the lead where two pieces
  meet exactly `leadWidth`, at any panel size;
- each letter is leaded the way a glazier cuts one: across the stroke from
  every sharp inside corner, and through every counter, so an H comes apart
  into two stems and a bar and no ring of glass is left round an O (from
  `shards` 3 up; `joins: false` turns it off);
- each letter's glass is cut to the font's own outline. A gap that is the
  font's own (the eye of an "e", the notch in an "N") keeps the font's
  width and fills with lead, never with more letter, so pick a face whose
  gaps are wide enough to print at your size;
- nothing thinner than `minFeature` is left to print — it becomes lead,
  and `warnings` says how much;
- the lead is one connected part, lead-first in the mesh list so it lands
  on filament slot 1 with the glass colors after it;
- every mesh is watertight.

So a width is something you change in the layout and rebuild, with the
same design. Nothing has to be redrawn.

### Having a model draw it

The dialect is small on purpose: it's what a language model can draw
reliably. `stainedGlassPrompt` writes the brief, for whichever model and
SDK you use:

```ts
import {
  stainedGlassPrompt,
  parseStainedGlassBrief,
  extractStainedGlassSvg,
} from "svg-to-3d/stained-glass/prompt"; // no imports of its own: a few KB on a server

// On the server. `layout.brief` is plain JSON from the client; parsing it
// leaves numbers, hex colors and single characters, and nothing else.
const brief = parseStainedGlassBrief(await request.json());
const { system, user } = stainedGlassPrompt(brief, {
  notes: "a sun behind the letters",
});
const reply = await yourModel({ system, user });
const design = extractStainedGlassSvg(reply); // null if it didn't draw one
```

Back on the client, `buildStainedGlass(layout, design)` as before. The
reply is only ever read as geometry — it's never put in a document — and a
design that ignores half the brief still builds. `glass.stats.leadFraction`
is a fair test of whether to keep it: the hand-made original is 0.32, and
much past 0.5 the model has drawn confetti.

### Options

| `layoutStainedGlass` | default                         |                                                            |
| -------------------- | ------------------------------- | ---------------------------------------------------------- |
| `text`, `font`       |                                 | one line; empty text (with a `height`) gives a plain panel |
| `width`              |                                 | overall mm, frame included; height follows from the text   |
| `frameWidth`         | 3.7                             | mm                                                         |
| `leadWidth`          | 2.2                             | mm, the lead between pieces                                |
| `shards`             | 6                               | 1 (a few panes) to 10 (a mosaic) — a target for the design |
| `colors`             | 4                               | total, lead included                                       |
| `palette`            | red, yellow, blue on near-black | `#rrggbb`, lead first, each one different                  |
| `margin`             | 0.57                            | glass between word and frame, × letter height              |
| `letterSpacing`      | `leadWidth`                     | mm between letters                                         |
| `minFeature`         | 0.8                             | mm, the narrowest glass worth printing                     |

| `buildStainedGlass` | default     |                                                         |
| ------------------- | ----------- | ------------------------------------------------------- |
| `thickness`         | 1.6         | mm of glass                                             |
| `letterHeight`      | `thickness` | raise it and the letters stand proud                    |
| `leadHeight`        | `thickness` | lower it and the glass stands proud                     |
| `bridge`            | true        | run a lead line out of any piece that surrounds another |

Print it the way the original was printed: one wall, 100% aligned
rectilinear infill, translucent PETG for the glass.

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
