import JSZip from "jszip";

import type { ColorMesh } from "./svgProcessor.js";

export type GroupingMode = "objects" | "parts";

export type ExportOptions = {
  /** Model name shown in the slicer's object list. */
  name?: string;
  /** Gap between objects on the plate in `"objects"` mode, in mm. */
  gap?: number;
};

const CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const MATERIAL_NS =
  "http://schemas.microsoft.com/3dmanufacturing/material/2015/02";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="text/xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  // Six decimals is plenty for FDM and keeps the file small.
  const s = Number(n.toFixed(6)).toString();
  return s === "-0" ? "0" : s;
}

/** `#rrggbb` → the `#RRGGBBAA` a 3MF color group wants. */
function colorAttr(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  return `#${(m ? m[1] : "808080").toUpperCase()}FF`;
}

/** Part names as the slicer's object list shows them. */
function partName(mesh: ColorMesh, index: number): string {
  return `${index + 1} ${mesh.color}`;
}

/**
 * Meshes are built Y-up (the art in XZ, the way three.js likes it). 3MF
 * puts the build plate in XY with Z up, so rotate +90° about X: (x, y, z)
 * → (x, -z, y). A rotation keeps the winding, so the triangles pass through
 * untouched and every face still points out.
 */
function meshXml(mesh: ColorMesh): string {
  const v = mesh.vertices;
  const t = mesh.triangles;
  const verts: string[] = [];
  for (let i = 0; i < v.length; i += 3) {
    verts.push(
      `<vertex x="${fmt(v[i])}" y="${fmt(-v[i + 2])}" z="${fmt(v[i + 1])}"/>`,
    );
  }
  const tris: string[] = [];
  for (let i = 0; i < t.length; i += 3) {
    tris.push(`<triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`);
  }
  return `<mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh>`;
}

/** Plate-space bounds (3MF x/y) of a mesh. */
function footprint(mesh: ColorMesh): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const v = mesh.vertices;
  const f = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  };
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i];
    const y = -v[i + 2];
    if (x < f.minX) f.minX = x;
    if (x > f.maxX) f.maxX = x;
    if (y < f.minY) f.minY = y;
    if (y > f.maxY) f.maxY = y;
  }
  return f;
}

/**
 * In `"objects"` mode every color ships as its own build item. They were
 * built in one frame, so left alone they'd all land on top of each other;
 * lay them out in a row instead, each one nudged so its own footprint is
 * clear of the last.
 */
function rowTransforms(meshes: ColorMesh[], gap: number): string[] {
  const prints = meshes.map(footprint);
  const totalWidth =
    prints.reduce((w, f) => w + (f.maxX - f.minX), 0) +
    gap * Math.max(0, meshes.length - 1);
  let cursor = -totalWidth / 2;
  return prints.map((f) => {
    const tx = cursor - f.minX;
    const ty = -(f.minY + f.maxY) / 2;
    cursor += f.maxX - f.minX + gap;
    return `1 0 0 0 1 0 0 0 1 ${fmt(tx)} ${fmt(ty)} 0`;
  });
}

type Layout = {
  colorGroupId: number;
  meshObjectIds: number[];
  assemblyId: number | null;
};

function layoutOf(meshes: ColorMesh[], mode: GroupingMode): Layout {
  const colorGroupId = 1;
  const meshObjectIds = meshes.map((_, idx) => colorGroupId + 1 + idx);
  const assemblyId = mode === "parts" ? colorGroupId + 1 + meshes.length : null;
  return { colorGroupId, meshObjectIds, assemblyId };
}

function buildModelXml(
  meshes: ColorMesh[],
  mode: GroupingMode,
  layout: Layout,
  options: ExportOptions,
): string {
  const { colorGroupId, meshObjectIds, assemblyId } = layout;
  const name = options.name ?? "svg-to-3d";

  // One display color per part, so viewers that read the material extension
  // (and Bambu Studio, for standalone objects) can tell the parts apart.
  const colorGroup =
    `<m:colorgroup id="${colorGroupId}">` +
    meshes.map((m) => `<m:color color="${colorAttr(m.color)}"/>`).join("") +
    `</m:colorgroup>`;

  const objects = meshes.map(
    (m, idx) =>
      `<object id="${meshObjectIds[idx]}" type="model" name="${escapeXml(
        partName(m, idx),
      )}" pid="${colorGroupId}" pindex="${idx}">` +
      meshXml(m) +
      `</object>`,
  );

  // In "parts" mode, wrap them in a single object using <components>.
  if (assemblyId !== null) {
    objects.push(
      `<object id="${assemblyId}" type="model" name="${escapeXml(name)}">` +
        `<components>` +
        meshObjectIds.map((id) => `<component objectid="${id}"/>`).join("") +
        `</components>` +
        `</object>`,
    );
  }

  const buildItems =
    assemblyId === null
      ? rowTransforms(meshes, options.gap ?? 5).map(
          (transform, idx) =>
            `<item objectid="${meshObjectIds[idx]}" transform="${transform}"/>`,
        )
      : [`<item objectid="${assemblyId}"/>`];

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:m="${MATERIAL_NS}">`,
    `<metadata name="Application">svg-to-3d</metadata>`,
    `<metadata name="Title">${escapeXml(name)}</metadata>`,
    `<resources>`,
    colorGroup,
    ...objects,
    `</resources>`,
    `<build>`,
    ...buildItems,
    `</build>`,
    `</model>`,
  ].join("");
}

/**
 * The one piece of slicer-specific metadata worth writing. Bambu Studio and
 * OrcaSlicer read `Metadata/model_settings.config` for part names and the
 * filament slot each part starts on, and both ignore the standard 3MF
 * material extensions for that job. Slot 1 for the first color, 2 for the
 * second, and so on — load the AMS to match and there's nothing to click.
 */
function modelSettingsXml(
  meshes: ColorMesh[],
  mode: GroupingMode,
  layout: Layout,
  options: ExportOptions,
): string {
  const { meshObjectIds, assemblyId } = layout;
  const name = options.name ?? "svg-to-3d";
  const part = (m: ColorMesh, idx: number, withExtruder: boolean): string =>
    `    <part id="${meshObjectIds[idx]}" subtype="normal_part">\n` +
    `      <metadata key="name" value="${escapeXml(partName(m, idx))}"/>\n` +
    (withExtruder
      ? `      <metadata key="extruder" value="${idx + 1}"/>\n`
      : "") +
    `    </part>\n`;

  let body: string;
  if (mode === "parts" && assemblyId !== null) {
    body =
      `  <object id="${assemblyId}">\n` +
      `    <metadata key="name" value="${escapeXml(name)}"/>\n` +
      `    <metadata key="extruder" value="1"/>\n` +
      meshes.map((m, idx) => part(m, idx, true)).join("") +
      `  </object>\n`;
  } else {
    body = meshes
      .map(
        (m, idx) =>
          `  <object id="${meshObjectIds[idx]}">\n` +
          `    <metadata key="name" value="${escapeXml(partName(m, idx))}"/>\n` +
          `    <metadata key="extruder" value="${idx + 1}"/>\n` +
          part(m, idx, false) +
          `  </object>\n`,
      )
      .join("");
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${body}</config>\n`;
}

/**
 * Write a 3MF package. `"parts"` makes every color a part of one object so
 * the slicer sees one model to assign filaments to (they arrive assigned:
 * color 1 on slot 1, color 2 on slot 2 …); `"objects"` drops every color on
 * the plate separately, laid out in a row, to print apart and glue up.
 */
export async function exportToThreeMf(
  meshes: ColorMesh[],
  mode: GroupingMode,
  options: ExportOptions = {},
): Promise<Blob> {
  const layout = layoutOf(meshes, mode);
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.folder("_rels")?.file(".rels", RELS);
  zip
    .folder("3D")
    ?.file("3dmodel.model", buildModelXml(meshes, mode, layout, options));
  zip
    .folder("Metadata")
    ?.file(
      "model_settings.config",
      modelSettingsXml(meshes, mode, layout, options),
    );
  return zip.generateAsync({
    type: "blob",
    mimeType: "model/3mf",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
