import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { build } from "./helpers.js";

// The hand-drawn sign the stained-glass generator was modelled on: lead as
// one path with a hole per pane, 56 panes in three colors. If the classic
// SVG path ever stops making this out of it, the generator's output (which
// has the same structure) is in trouble too.
const art = readFileSync(
  new URL("./fixtures/hunt-stained-glass.svg", import.meta.url),
  "utf8",
);

const components = (mesh) => {
  const parent = Array.from({ length: mesh.vertices.length / 3 }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    parent[find(t[i])] = find(t[i + 1]);
    parent[find(t[i])] = find(t[i + 2]);
  }
  return new Set(Array.from(t, (v) => find(v))).size;
};

test("the reference sign: one lead part, 56 panes, all watertight", () => {
  const meshes = build(art, { extrudeDepth: 1.6 }, 250 / 1260.68);
  assert.equal(meshes.length, 4);
  for (const mesh of meshes) assert.equal(mesh.nonManifoldEdges, 0);
  const lead = meshes.find((m) => m.color === "#080910");
  assert.equal(components(lead), 1);
  const panes = meshes
    .filter((m) => m !== lead)
    .reduce((sum, m) => sum + components(m), 0);
  assert.equal(panes, 56);
});
