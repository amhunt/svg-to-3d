import JSZip from "jszip";

import type { ColorMesh } from "./svgProcessor.js";

export type GroupingMode = "objects" | "parts";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
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
  return Number(n.toFixed(6)).toString();
}

function meshXml(mesh: ColorMesh): string {
  const v = mesh.vertices;
  const t = mesh.triangles;
  const verts: string[] = [];
  for (let i = 0; i < v.length; i += 3) {
    verts.push(
      `<vertex x="${fmt(v[i])}" y="${fmt(v[i + 1])}" z="${fmt(v[i + 2])}"/>`,
    );
  }
  const tris: string[] = [];
  for (let i = 0; i < t.length; i += 3) {
    tris.push(`<triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`);
  }
  return `<mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh>`;
}

function buildModelXml(meshes: ColorMesh[], mode: GroupingMode): string {
  // Each color gets an <object type="model"> with its mesh.
  const meshObjectIds = meshes.map((_, idx) => idx + 1);
  const objects = meshes.map(
    (m, idx) =>
      `<object id="${meshObjectIds[idx]}" type="model" name="${escapeXml(
        `color_${m.color}`,
      )}" pid="0" pindex="0">` +
      `<metadata name="Color">${escapeXml(m.color)}</metadata>` +
      meshXml(m) +
      `</object>`,
  );

  // In "parts" mode, wrap them in a single object using <components>.
  const assemblyId = mode === "parts" ? meshes.length + 1 : null;
  if (assemblyId !== null) {
    objects.push(
      `<object id="${assemblyId}" type="model" name="assembly">` +
        `<components>` +
        meshObjectIds.map((id) => `<component objectid="${id}"/>`).join("") +
        `</components>` +
        `</object>`,
    );
  }

  const buildItems =
    assemblyId === null
      ? meshObjectIds.map((id) => `<item objectid="${id}"/>`)
      : [`<item objectid="${assemblyId}"/>`];

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`,
    `<metadata name="Application">hunt.codes svg-to-3d</metadata>`,
    `<resources>`,
    ...objects,
    `</resources>`,
    `<build>`,
    ...buildItems,
    `</build>`,
    `</model>`,
  ].join("");
}

export async function exportToThreeMf(
  meshes: ColorMesh[],
  mode: GroupingMode,
): Promise<Blob> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.folder("_rels")?.file(".rels", RELS);
  zip.folder("3D")?.file("3dmodel.model", buildModelXml(meshes, mode));
  return zip.generateAsync({
    type: "blob",
    mimeType: "model/3mf",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
