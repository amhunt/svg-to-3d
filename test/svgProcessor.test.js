import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeSvg,
  processAnalysis,
  DEFAULT_PART_OPTIONS,
} from "../dist/index.js";
import {
  build,
  bounds,
  center,
  near,
  signedVolume,
  svg,
  unpairedEdges,
} from "./helpers.js";

const byColor = (meshes) => Object.fromEntries(meshes.map((m) => [m.color, m]));

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

test("groups shapes by fill color", () => {
  const analysis = analyzeSvg(
    svg(
      `<rect x="0" y="0" width="40" height="40" fill="#ff0000"/>
       <rect x="50" y="0" width="40" height="40" fill="#0000ff"/>
       <rect x="0" y="50" width="40" height="40" fill="#ff0000"/>`,
    ),
  );
  assert.deepEqual(analysis.colors, ["#ff0000", "#0000ff"]);
  assert.equal(analysis.shapesByColor.get("#ff0000").length, 2);
  assert.equal(analysis.shapesByColor.get("#0000ff").length, 1);
  assert.deepEqual(
    analysis.layers.map((l) => l.color),
    ["#ff0000", "#0000ff", "#ff0000"],
  );
});

test("every spelling of a color is one color", () => {
  const analysis = analyzeSvg(
    svg(
      `<rect x="0" y="0" width="10" height="10" fill="red"/>
       <rect x="20" y="0" width="10" height="10" fill="#F00"/>
       <rect x="40" y="0" width="10" height="10" fill="#FF0000"/>
       <rect x="60" y="0" width="10" height="10" fill="rgb(255, 0, 0)"/>
       <rect x="80" y="0" width="10" height="10" fill="rgb(100%,0%,0%)"/>
       <rect x="0" y="20" width="10" height="10" fill="hsl(0, 100%, 50%)"/>
       <rect x="20" y="20" width="10" height="10" style="fill:#ff0000"/>
       <rect x="40" y="20" width="10" height="10"/>
       <g color="#ff0000"><rect x="60" y="20" width="10" height="10" fill="currentColor"/></g>`,
    ),
  );
  assert.deepEqual(analysis.colors, ["#ff0000", "#000000"]);
  assert.equal(analysis.shapesByColor.get("#ff0000").length, 8);
});

test("partial opacity prints solid and is reported", () => {
  const analysis = analyzeSvg(
    svg(
      `<rect x="0" y="0" width="10" height="10" fill="#00aa0080"/>
       <rect x="20" y="0" width="10" height="10" fill="rgba(0,170,0,0.5)"/>
       <rect x="40" y="0" width="10" height="10" fill="#00aa00" fill-opacity="0.5"/>
       <rect x="60" y="0" width="10" height="10" fill="#0000ff"/>`,
    ),
  );
  assert.deepEqual(analysis.colors, ["#00aa00", "#0000ff"]);
  assert.deepEqual(analysis.skipped.translucent, ["#00aa00"]);
});

// ---------------------------------------------------------------------------
// What gets left out, and that it says so
// ---------------------------------------------------------------------------

test("hidden art stays out", () => {
  const analysis = analyzeSvg(
    svg(
      `<g style="display:none"><rect x="0" y="0" width="50" height="50" fill="#ff00ff"/></g>
       <rect x="0" y="0" width="10" height="10" fill="#00ff00" visibility="hidden"/>
       <rect x="20" y="0" width="10" height="10" fill="#00ffff" opacity="0"/>
       <rect x="40" y="0" width="10" height="10" fill="#ffff00" fill-opacity="0"/>
       <rect x="60" y="0" width="10" height="10" fill="transparent"/>
       <rect x="80" y="0" width="10" height="10" fill="#0000ff"/>`,
    ),
  );
  assert.deepEqual(analysis.colors, ["#0000ff"]);
  assert.equal(analysis.skipped.hidden, 5);
});

test("a Figma mask outside <defs> is not artwork", () => {
  const analysis = analyzeSvg(
    svg(
      `<mask id="m"><rect x="0" y="0" width="100" height="100" fill="#d9d9d9"/></mask>
       <g mask="url(#m)"><rect x="10" y="10" width="30" height="30" fill="#ff0000"/></g>`,
    ),
  );
  assert.deepEqual(analysis.colors, ["#ff0000"]);
  assert.equal(analysis.skipped.masks, 1);
});

test("a clip to the whole canvas is silent, any other clip is reported", () => {
  const framed = analyzeSvg(
    svg(
      `<g clip-path="url(#c)"><rect x="10" y="10" width="30" height="30" fill="#ff0000"/></g>
       <defs><clipPath id="c"><rect width="100" height="100" fill="white"/></clipPath></defs>`,
    ),
  );
  assert.deepEqual(framed.colors, ["#ff0000"]);
  assert.equal(framed.skipped.clipPaths, 0);

  const clipped = analyzeSvg(
    svg(
      `<clipPath id="c"><circle cx="50" cy="50" r="30"/></clipPath>
       <rect width="100" height="100" fill="#8ac926" clip-path="url(#c)"/>`,
    ),
  );
  assert.deepEqual(clipped.colors, ["#8ac926"]);
  assert.equal(clipped.skipped.clipPaths, 1);
});

test("strokes, text and bitmaps are counted, not printed", () => {
  const analysis = analyzeSvg(
    svg(
      `<path d="M10 10 L90 90" fill="none" stroke="#000" stroke-width="2"/>
       <circle cx="50" cy="50" r="20" fill="#ffcc00" stroke="#000" stroke-width="3"/>
       <text x="10" y="90" fill="#000">hi</text>
       <image href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/>`,
    ),
  );
  assert.deepEqual(analysis.colors, ["#ffcc00"]);
  assert.equal(analysis.skipped.strokes, 2);
  assert.equal(analysis.skipped.text, 1);
  assert.equal(analysis.skipped.images, 1);
});

test("gradients flatten to their first stop, patterns are skipped", () => {
  const analysis = analyzeSvg(
    svg(
      `<defs>
         <linearGradient id="g"><stop offset="1" stop-color="#0000ff"/><stop offset="0" stop-color="#ff0000"/></linearGradient>
         <pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="#000"/></pattern>
       </defs>
       <rect x="10" y="10" width="30" height="30" fill="url(#g)"/>
       <rect x="50" y="10" width="30" height="30" fill="url(#p)"/>`,
    ),
  );
  assert.deepEqual(analysis.colors, ["#ff0000"]);
  assert.equal(analysis.skipped.gradients, 1);
  assert.equal(analysis.skipped.patterns, 1);
});

test("SVG 2 <use href> works", () => {
  const analysis = analyzeSvg(
    svg(
      `<defs><rect id="r" x="0" y="0" width="20" height="20"/></defs>
       <use href="#r" fill="#ff0000"/>
       <use href="#r" x="30" fill="#ff0000"/>`,
    ),
  );
  assert.deepEqual(analysis.colors, ["#ff0000"]);
  assert.equal(analysis.shapesByColor.get("#ff0000").length, 2);
});

test("reads the document's physical size", () => {
  const physical = analyzeSvg(
    svg(
      `<rect width="10" height="10"/>`,
      "0 0 500 250",
      'width="50mm" height="25mm"',
    ),
  );
  assert.deepEqual(physical.document.physicalSize, { width: 50, height: 25 });
  assert.ok(near(physical.document.mmPerUnit, 0.1, 1e-9));
  assert.deepEqual(physical.document.viewBox, {
    x: 0,
    y: 0,
    width: 500,
    height: 250,
  });

  const inches = analyzeSvg(
    svg(
      `<rect width="10" height="10"/>`,
      "0 0 100 100",
      'width="2in" height="2in"',
    ),
  );
  assert.ok(near(inches.document.mmPerUnit, 0.508, 1e-6));

  const unitless = analyzeSvg(
    svg(
      `<rect width="10" height="10"/>`,
      "0 0 100 100",
      'width="100" height="100"',
    ),
  );
  assert.equal(unitless.document.physicalSize, null);
  assert.equal(unitless.document.mmPerUnit, null);
});

test("broken XML throws instead of extruding half a file", () => {
  assert.throws(
    () =>
      analyzeSvg(
        `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"<circle r="3"/></svg`,
      ),
    /isn't an SVG/,
  );
  assert.throws(
    () => analyzeSvg(`<html><body>nope</body></html>`),
    /isn't an SVG/,
  );
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

test("a plain square extrudes to a closed, outward-facing solid", () => {
  const [mesh] = build(
    svg(`<rect x="10" y="10" width="80" height="80" fill="#ff0000"/>`),
  );
  assert.equal(mesh.nonManifoldEdges, 0);
  assert.equal(unpairedEdges(mesh), 0);
  assert.ok(
    near(signedVolume(mesh), 80 * 80 * 2),
    `volume ${signedVolume(mesh)}`,
  );
  assert.equal(mesh.vertices.length % 3, 0);
  assert.equal(mesh.triangles.length % 3, 0);
});

test("a shape with a hole stays manifold", () => {
  const [mesh] = build(
    svg(`<path d="M10 10 H90 V90 H10 Z M30 30 V70 H70 V30 Z" fill="#0000ff"/>`),
  );
  assert.equal(mesh.nonManifoldEdges, 0);
  assert.equal(unpairedEdges(mesh), 0);
  assert.ok(near(signedVolume(mesh), (80 * 80 - 40 * 40) * 2));
});

test("two touching same-color shapes fuse into one manifold solid", () => {
  // Shared edge at x=50: each rect would extrude its own wall there, leaving
  // the edge bordered by four triangles until the internal walls dissolve.
  const [mesh] = build(
    svg(`<rect x="0" y="0" width="50" height="50" fill="#00ff00"/>
         <rect x="50" y="0" width="50" height="50" fill="#00ff00"/>`),
  );
  assert.equal(mesh.nonManifoldEdges, 0);
  assert.ok(near(signedVolume(mesh), 100 * 50 * 2));
});

test("shapes touching at a single point do not pinch", () => {
  // Corner-to-corner contact is a non-manifold pinch in 3D; sub-micron erosion
  // should open it into two independently watertight solids.
  const [mesh] = build(
    svg(`<rect x="0" y="0" width="50" height="50" fill="#00ff00"/>
         <rect x="50" y="50" width="50" height="50" fill="#00ff00"/>`),
  );
  assert.equal(mesh.nonManifoldEdges, 0);
});

test("SVG down is +Z, and the art is not mirrored", () => {
  const meshes = build(
    svg(`<rect x="0" y="0" width="10" height="10" fill="#ff0000"/>
         <rect x="80" y="80" width="10" height="10" fill="#0000ff"/>`),
  );
  const { "#ff0000": topLeft, "#0000ff": bottomRight } = byColor(meshes);
  const [tx, , tz] = center(topLeft);
  const [bx, , bz] = center(bottomRight);
  assert.ok(tx < bx, "SVG right should be +X");
  assert.ok(tz < bz, "SVG down should be +Z");
});

test("every color becomes its own mesh, and the assembly rests on the plate", () => {
  const meshes = build(
    svg(`<rect x="0" y="0" width="40" height="40" fill="#ff0000"/>
         <rect x="50" y="0" width="40" height="40" fill="#0000ff"/>`),
  );
  assert.equal(meshes.length, 2);
  for (const m of meshes) assert.equal(m.nonManifoldEdges, 0);
  const minY = Math.min(...meshes.map((m) => bounds(m).min[1]));
  assert.ok(Math.abs(minY) < 1e-6, `model should sit at y=0, got ${minY}`);
});

test("extrude depth is honoured", () => {
  const [mesh] = build(
    svg(`<rect x="10" y="10" width="80" height="80" fill="#ff0000"/>`),
    { extrudeDepth: 5 },
  );
  assert.ok(near(bounds(mesh).max[1], 5, 1e-6));
});

// ---------------------------------------------------------------------------
// Painter's order
// ---------------------------------------------------------------------------

const FACE = svg(
  `<circle cx="50" cy="50" r="45" fill="#111111"/>
   <circle cx="35" cy="40" r="10" fill="#ffffff"/>
   <circle cx="35" cy="40" r="4" fill="#111111"/>`,
);
const discArea = (r) => Math.PI * r * r * Math.cos(Math.PI / 48); // 48-gon

test("overlapping colors are flattened in paint order", () => {
  const { "#111111": black, "#ffffff": white } = byColor(build(FACE));
  // The pupil is black again, and the eye has a hole where it sits.
  assert.ok(near(signedVolume(white), (discArea(10) - discArea(4)) * 2, 0.005));
  assert.ok(
    near(
      signedVolume(black),
      (discArea(45) - discArea(10) + discArea(4)) * 2,
      0.005,
    ),
  );
  for (const m of [black, white]) {
    assert.equal(m.nonManifoldEdges, 0);
    assert.equal(unpairedEdges(m), 0);
  }
});

test("flatten: false keeps every color's full footprint", () => {
  const { "#111111": black, "#ffffff": white } = byColor(
    build(FACE, {}, 1, { flatten: false }),
  );
  assert.ok(near(signedVolume(white), discArea(10) * 2, 0.005));
  assert.ok(near(signedVolume(black), discArea(45) * 2, 0.005));
});

test("a color painted over completely has no part", () => {
  const meshes = build(
    svg(`<rect x="10" y="10" width="50" height="50" fill="#ff0000"/>
         <rect x="0" y="0" width="100" height="100" fill="#0000ff"/>`),
  );
  assert.deepEqual(
    meshes.map((m) => m.color),
    ["#0000ff"],
  );
});

// ---------------------------------------------------------------------------
// Bevels
// ---------------------------------------------------------------------------

const BADGE = svg(
  `<circle cx="50" cy="50" r="48" fill="#1f3a5f"/>
   <circle cx="50" cy="50" r="40" fill="#f4d35e"/>
   <path d="M35 25 H70 V35 H47 V45 H65 V55 H47 V75 H35 Z" fill="#e4572e"/>`,
);
const BEVEL = {
  bevelTop: true,
  bevelBottom: true,
  bevelSize: 0.6,
  bevelThickness: 0.6,
};

test("bevelled parts stay manifold and lose volume", () => {
  const [plain] = build(
    svg(`<rect x="10" y="10" width="80" height="80" fill="#ff0000"/>`),
  );
  const [mesh] = build(
    svg(`<rect x="10" y="10" width="80" height="80" fill="#ff0000"/>`),
    BEVEL,
  );
  assert.equal(mesh.nonManifoldEdges, 0);
  assert.equal(unpairedEdges(mesh), 0);
  // Two chamfers of 0.6 × 0.6 / 2 around a 320 mm perimeter.
  assert.ok(
    near(signedVolume(mesh), signedVolume(plain) - 320 * 0.18 * 2, 0.005),
  );
  assert.equal(mesh.bevelFallbacks, 0);
});

test("a hole with air in it is chamfered too, and the chamfer goes into the solid", () => {
  const [plain] = build(
    svg(`<path d="M10 10 H90 V90 H10 Z M30 30 V70 H70 V30 Z" fill="#0000ff"/>`),
  );
  const [mesh] = build(
    svg(`<path d="M10 10 H90 V90 H10 Z M30 30 V70 H70 V30 Z" fill="#0000ff"/>`),
    BEVEL,
  );
  assert.equal(unpairedEdges(mesh), 0);
  assert.ok(
    near(
      signedVolume(mesh),
      signedVolume(plain) - (320 + 160) * 0.18 * 2,
      0.005,
    ),
  );
});

test("bevels skip the seams between colors", () => {
  const plain = byColor(build(BADGE));
  const bevelled = byColor(build(BADGE, BEVEL));
  // The yellow ring touches navy outside and the F inside: nothing to chamfer.
  assert.ok(
    near(
      signedVolume(bevelled["#f4d35e"]),
      signedVolume(plain["#f4d35e"]),
      1e-6,
    ),
  );
  assert.ok(
    near(
      signedVolume(bevelled["#e4572e"]),
      signedVolume(plain["#e4572e"]),
      1e-6,
    ),
  );
  // Navy's outer edge is in the open and gets its chamfer.
  assert.ok(
    signedVolume(bevelled["#1f3a5f"]) < signedVolume(plain["#1f3a5f"]) - 50,
  );
  for (const m of Object.values(bevelled)) assert.equal(unpairedEdges(m), 0);
});

test("a color standing proud of its neighbours gets its top chamfer back", () => {
  const analysis = analyzeSvg(BADGE);
  const depths = { "#1f3a5f": 2, "#f4d35e": 2.6, "#e4572e": 3.2 };
  const stack = (bevelTop) =>
    byColor(
      processAnalysis(
        analysis,
        1,
        new Map(
          analysis.colors.map((c) => [
            c,
            { ...DEFAULT_PART_OPTIONS, extrudeDepth: depths[c], bevelTop },
          ]),
        ),
      ),
    );
  const plain = stack(false);
  const bevelled = stack(true);
  // The F stands 0.6 mm above the yellow, so its whole top edge is in the open.
  assert.ok(
    signedVolume(bevelled["#e4572e"]) < signedVolume(plain["#e4572e"]) - 10,
  );
  // Yellow is above navy on the outside (chamfered) but under the F inside (not).
  assert.ok(
    signedVolume(bevelled["#f4d35e"]) < signedVolume(plain["#f4d35e"]) - 10,
  );
  for (const m of Object.values(bevelled)) {
    assert.equal(unpairedEdges(m), 0);
    assert.equal(m.bevelFallbacks, 0);
  }
});

test("a bevel that doesn't fit falls back to square edges and says so", () => {
  const [mesh] = build(
    svg(`<rect x="10" y="10" width="0.5" height="80" fill="#ff0000"/>`),
    { ...BEVEL, bevelSize: 0.6 },
  );
  assert.equal(mesh.nonManifoldEdges, 0);
  assert.equal(mesh.bevelFallbacks, 1);
});
