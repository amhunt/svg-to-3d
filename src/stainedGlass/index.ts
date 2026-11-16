export { layoutStainedGlass, DEFAULT_STAINED_GLASS_PALETTE } from "./layout.js";
export type {
  Box,
  FontLike,
  GlyphPathCommand,
  StainedGlassLayout,
  StainedGlassLayoutOptions,
  StainedGlassLetter,
  StainedGlassWarning,
} from "./layout.js";

export { buildStainedGlass } from "./build.js";
export type {
  StainedGlass,
  StainedGlassOptions,
  StainedGlassPiece,
} from "./build.js";

export { starterStainedGlass } from "./starter.js";

export {
  stainedGlassPrompt,
  stainedGlassTargets,
  parseStainedGlassBrief,
  extractStainedGlassSvg,
} from "./prompt.js";
export type {
  BriefBox,
  StainedGlassBrief,
  StainedGlassTargets,
} from "./prompt.js";

export type { DesignRegion } from "./design.js";

// So a sign can be made and saved from this entry alone
export { exportToThreeMf } from "../threeMfExporter.js";
export type { ExportOptions, GroupingMode } from "../threeMfExporter.js";
export type { ColorMesh } from "../solids.js";
