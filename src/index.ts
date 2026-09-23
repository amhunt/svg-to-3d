export {
  analyzeSvg,
  processAnalysis,
  DEFAULT_PART_OPTIONS,
} from "./svgProcessor.js";
export type {
  ColorMesh,
  PartOptions,
  ProcessOptions,
  SkippedContent,
  SvgAnalysis,
  SvgDocumentInfo,
  SvgLayer,
} from "./svgProcessor.js";

export { exportToThreeMf } from "./threeMfExporter.js";
export type { ExportOptions, GroupingMode } from "./threeMfExporter.js";
