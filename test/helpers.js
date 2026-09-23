import {
  analyzeSvg,
  processAnalysis,
  DEFAULT_PART_OPTIONS,
} from "../dist/index.js";

export const svg = (body, viewBox = "0 0 100 100", attrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" ${attrs}>${body}</svg>`;

/** Build every color's mesh with one shared set of part options. */
export const build = (svgText, opts = {}, scale = 1, processOptions = {}) => {
  const analysis = analyzeSvg(svgText);
  const byColor = new Map(
    analysis.colors.map((c) => [c, { ...DEFAULT_PART_OPTIONS, ...opts }]),
  );
  return processAnalysis(analysis, scale, byColor, processOptions);
};

/** Signed volume by the divergence theorem: positive when faces point out. */
export const signedVolume = (mesh) => {
  const v = mesh.vertices;
  const t = mesh.triangles;
  let six = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3;
    const b = t[i + 1] * 3;
    const c = t[i + 2] * 3;
    six +=
      v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
      v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
      v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return six / 6;
};

/** Directed edges without a partner walked the other way. 0 for a closed, consistently wound surface. */
export const unpairedEdges = (mesh) => {
  const t = mesh.triangles;
  const seen = new Map();
  for (let i = 0; i < t.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const k = `${t[i + j]}_${t[i + ((j + 1) % 3)]}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [k, n] of seen) {
    const [a, b] = k.split("_");
    if (n !== 1 || seen.get(`${b}_${a}`) !== 1) bad++;
  }
  return bad;
};

export const bounds = (mesh) => {
  const v = mesh.vertices;
  const b = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      b.min[k] = Math.min(b.min[k], v[i + k]);
      b.max[k] = Math.max(b.max[k], v[i + k]);
    }
  }
  return b;
};

export const center = (mesh) => {
  const b = bounds(mesh);
  return b.min.map((lo, k) => (lo + b.max[k]) / 2);
};

export const near = (actual, expected, tolerance = 0.01) =>
  Math.abs(actual - expected) <= Math.abs(expected) * tolerance;
