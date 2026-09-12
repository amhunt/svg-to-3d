import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";

import {
  analyzeSvg,
  processAnalysis,
  DEFAULT_PART_OPTIONS,
  exportToThreeMf,
} from "../dist/index.js";

const svg = (body, viewBox = "0 0 100 100") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;

/** Build every color's mesh with one shared set of part options. */
const build = (svgText, opts = {}, scale = 1) => {
  const analysis = analyzeSvg(svgText);
  const byColor = new Map(
    analysis.colors.map((c) => [c, { ...DEFAULT_PART_OPTIONS, ...opts }]),
  );
  return processAnalysis(analysis, scale, byColor);
};

test("groups shapes by fill color", () => {
  const analysis = analyzeSvg(
    svg(
      `<rect x="0" y="0" width="40" height="40" fill="#ff0000"/>
       <rect x="50" y="0" width="40" height="40" fill="#0000ff"/>
       <rect x="0" y="50" width="40" height="40" fill="#ff0000"/>`,
    ),
  );
  assert.deepEqual(new Set(analysis.colors), new Set(["#ff0000", "#0000ff"]));
  assert.equal(analysis.shapesByColor.get("#ff0000").length, 2);
  assert.equal(analysis.shapesByColor.get("#0000ff").length, 1);
});

test("a plain square extrudes to a closed manifold solid", () => {
  const [mesh] = build(svg(`<rect x="10" y="10" width="80" height="80" fill="#ff0000"/>`));
  assert.equal(mesh.nonManifoldEdges, 0);
  assert.ok(mesh.triangles.length >= 36, "expected at least a full box of tris");
  assert.equal(mesh.vertices.length % 3, 0);
  assert.equal(mesh.triangles.length % 3, 0);
});

test("a shape with a hole stays manifold", () => {
  const [mesh] = build(
    svg(`<path d="M10 10 H90 V90 H10 Z M30 30 V70 H70 V30 Z" fill="#0000ff"/>`),
  );
  assert.equal(mesh.nonManifoldEdges, 0);
});

test("two touching same-color shapes fuse into one manifold solid", () => {
  // Shared edge at x=50: each rect would extrude its own wall there, leaving
  // the edge bordered by four triangles until the internal walls dissolve.
  const [mesh] = build(
    svg(`<rect x="0" y="0" width="50" height="50" fill="#00ff00"/>
         <rect x="50" y="0" width="50" height="50" fill="#00ff00"/>`),
  );
  assert.equal(mesh.nonManifoldEdges, 0);
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

test("bevelled parts stay manifold", () => {
  const [mesh] = build(
    svg(`<rect x="10" y="10" width="80" height="80" fill="#ff0000"/>`),
    { bevelTop: true, bevelBottom: true, bevelSize: 0.6, bevelThickness: 0.6 },
  );
  assert.equal(mesh.nonManifoldEdges, 0);
});

test("every color becomes its own mesh, and the assembly rests on the plate", () => {
  const meshes = build(
    svg(`<rect x="0" y="0" width="40" height="40" fill="#ff0000"/>
         <rect x="50" y="0" width="40" height="40" fill="#0000ff"/>`),
  );
  assert.equal(meshes.length, 2);
  for (const m of meshes) assert.equal(m.nonManifoldEdges, 0);

  let minY = Infinity;
  for (const m of meshes) {
    for (let i = 1; i < m.vertices.length; i += 3) minY = Math.min(minY, m.vertices[i]);
  }
  assert.ok(Math.abs(minY) < 1e-6, `model should sit at y=0, got ${minY}`);
});

test("extrude depth is honoured", () => {
  const [mesh] = build(
    svg(`<rect x="10" y="10" width="80" height="80" fill="#ff0000"/>`),
    { extrudeDepth: 5 },
  );
  let maxY = -Infinity;
  for (let i = 1; i < mesh.vertices.length; i += 3) maxY = Math.max(maxY, mesh.vertices[i]);
  assert.ok(Math.abs(maxY - 5) < 1e-6, `expected 5mm tall, got ${maxY}`);
});

test("exports a 3MF package a slicer can open", async () => {
  const meshes = build(
    svg(`<rect x="0" y="0" width="40" height="40" fill="#ff0000"/>
         <rect x="50" y="0" width="40" height="40" fill="#0000ff"/>`),
  );
  const blob = await exportToThreeMf(meshes, "parts");
  assert.ok(blob.size > 0);

  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.ok(zip.file("[Content_Types].xml"), "missing content types");
  assert.ok(zip.file("_rels/.rels"), "missing rels");

  const model = await zip.file("3D/3dmodel.model").async("string");
  assert.match(model, /<model/);
  assert.match(model, /ff0000/i);
  assert.match(model, /0000ff/i);
});

test("grouping modes both produce a readable model", async () => {
  const meshes = build(svg(`<rect x="0" y="0" width="40" height="40" fill="#ff0000"/>`));
  for (const mode of ["parts", "objects"]) {
    const zip = await JSZip.loadAsync(
      await (await exportToThreeMf(meshes, mode)).arrayBuffer(),
    );
    const model = await zip.file("3D/3dmodel.model").async("string");
    assert.match(model, /<build>/);
  }
});
