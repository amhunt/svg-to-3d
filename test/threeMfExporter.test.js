import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";

import { exportToThreeMf } from "../dist/index.js";
import { build, svg } from "./helpers.js";

const TWO_COLORS = svg(
  `<rect x="0" y="0" width="40" height="40" fill="#ff0000"/>
   <rect x="50" y="60" width="40" height="40" fill="#0000ff"/>`,
);

const unpack = async (meshes, mode, options) => {
  const blob = await exportToThreeMf(meshes, mode, options);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const read = async (name) => {
    const file = zip.file(name);
    return file ? file.async("string") : null;
  };
  return {
    blob,
    model: await read("3D/3dmodel.model"),
    settings: await read("Metadata/model_settings.config"),
    contentTypes: await read("[Content_Types].xml"),
    rels: await read("_rels/.rels"),
  };
};

/** Every object's vertices, keyed by object id, plus the build items. */
const parseModel = (model) => {
  const objects = new Map();
  for (const m of model.matchAll(
    /<object id="(\d+)"[^>]*>(?:(?!<\/object>).)*?<mesh><vertices>(.*?)<\/vertices>/gs,
  )) {
    objects.set(
      m[1],
      Array.from(
        m[2].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g),
        (v) => v.slice(1, 4).map(Number),
      ),
    );
  }
  const items = Array.from(
    model.matchAll(/<item objectid="(\d+)"(?: transform="([^"]*)")?/g),
    (m) => ({ id: m[1], transform: m[2]?.split(" ").map(Number) ?? null }),
  );
  return { objects, items };
};

const extent = (vertices, axis) => {
  const values = vertices.map((v) => v[axis]);
  return [Math.min(...values), Math.max(...values)];
};

test("exports a 3MF package a slicer can open", async () => {
  const { blob, model, contentTypes, rels } = await unpack(
    build(TWO_COLORS),
    "parts",
  );
  assert.ok(blob.size > 0);
  assert.ok(contentTypes.includes('Extension="model"'));
  assert.ok(contentTypes.includes('Extension="config"'));
  assert.ok(rels.includes("/3D/3dmodel.model"));
  assert.match(model, /<model unit="millimeter"/);
});

test("the model is Z-up, rests on the plate, and reads the right way round", async () => {
  const meshes = build(TWO_COLORS);
  const { model } = await unpack(meshes, "parts");
  const { objects } = parseModel(model);
  assert.equal(objects.size, 2);
  for (const vertices of objects.values()) {
    const [lo, hi] = extent(vertices, 2);
    assert.ok(Math.abs(lo) < 1e-6, `part should start at z=0, got ${lo}`);
    assert.ok(Math.abs(hi - 2) < 1e-6, `part should be 2mm tall, got ${hi}`);
  }
  // SVG's top-left red square sits at the back-left of the plate: -x, +y.
  const [red, blue] = objects.values();
  assert.ok(extent(red, 0)[1] < extent(blue, 0)[0], "red is left of blue");
  assert.ok(extent(red, 1)[0] > extent(blue, 1)[1], "red is behind blue");
});

test("triangles keep their outward winding through the axis swap", async () => {
  const [mesh] = build(
    svg(`<rect x="10" y="10" width="80" height="80" fill="#ff0000"/>`),
  );
  const { model } = await unpack([mesh], "parts");
  const { objects } = parseModel(model);
  const [vertices] = objects.values();
  const tris = Array.from(
    model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g),
    (m) => m.slice(1, 4).map(Number),
  );
  let six = 0;
  for (const [a, b, c] of tris) {
    const [ax, ay, az] = vertices[a];
    const [bx, by, bz] = vertices[b];
    const [cx, cy, cz] = vertices[c];
    six +=
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx);
  }
  assert.ok(Math.abs(six / 6 - 80 * 80 * 2) < 1, `signed volume ${six / 6}`);
});

test("every part carries its color, a name and a valid property reference", async () => {
  const { model } = await unpack(build(TWO_COLORS), "parts");
  assert.match(
    model,
    /<m:colorgroup id="1"><m:color color="#FF0000FF"\/><m:color color="#0000FFFF"\/><\/m:colorgroup>/,
  );
  assert.match(
    model,
    /<object id="2" type="model" name="1 #ff0000" pid="1" pindex="0">/,
  );
  assert.match(
    model,
    /<object id="3" type="model" name="2 #0000ff" pid="1" pindex="1">/,
  );
  assert.doesNotMatch(model, /pid="0"/);
  assert.doesNotMatch(model, /<object[^>]*><metadata/);
});

test("parts mode is one object whose parts arrive on filament slots 1, 2, 3 …", async () => {
  const { model, settings } = await unpack(build(TWO_COLORS), "parts", {
    name: "rocket",
  });
  assert.match(
    model,
    /<object id="4" type="model" name="rocket"><components><component objectid="2"\/><component objectid="3"\/><\/components><\/object>/,
  );
  assert.deepEqual(parseModel(model).items, [{ id: "4", transform: null }]);
  assert.match(
    settings,
    /<object id="4">\s*<metadata key="name" value="rocket"\/>/,
  );
  assert.match(
    settings,
    /<part id="2" subtype="normal_part">\s*<metadata key="name" value="1 #ff0000"\/>\s*<metadata key="extruder" value="1"\/>/,
  );
  assert.match(
    settings,
    /<part id="3" subtype="normal_part">\s*<metadata key="name" value="2 #0000ff"\/>\s*<metadata key="extruder" value="2"\/>/,
  );
});

test("objects mode lays the colors out in a row, each on its own slot", async () => {
  const meshes = build(TWO_COLORS);
  const { model, settings } = await unpack(meshes, "objects");
  const { objects, items } = parseModel(model);
  assert.equal(items.length, 2);
  const placed = items.map(({ id, transform }) => {
    const [x0, x1] = extent(objects.get(id), 0);
    return [x0 + transform[9], x1 + transform[9]];
  });
  assert.ok(
    placed[0][1] + 5 <= placed[1][0] + 1e-6,
    `objects overlap: ${placed}`,
  );
  assert.match(
    settings,
    /<object id="2">\s*<metadata key="name" value="1 #ff0000"\/>\s*<metadata key="extruder" value="1"\/>/,
  );
  assert.match(
    settings,
    /<object id="3">\s*<metadata key="name" value="2 #0000ff"\/>\s*<metadata key="extruder" value="2"\/>/,
  );
});

test("XML in names is escaped", async () => {
  const { model, settings } = await unpack(build(TWO_COLORS), "parts", {
    name: `a<b>&"c"`,
  });
  assert.match(model, /name="a&lt;b&gt;&amp;&quot;c&quot;"/);
  assert.match(settings, /value="a&lt;b&gt;&amp;&quot;c&quot;"/);
});
