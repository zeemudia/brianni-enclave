export { detectPII, PII_PATTERNS } from "./patterns";
export { PIITokeniser, findSafeEmitPoint } from "./tokeniser";
export {
  maskHistoricalUserContent,
  buildMaskedOutboundHistory,
} from "./history";
export type { OutboundHistoryMessage } from "./history";
export type {
  PIIEntity,
  PIIDetectionSource,
  PIIPattern,
  PIIToken,
} from "./types";

export { analyseStyle, applyAccepted } from "./stylometric";
export type { StyleCategory, StyleSuggestion } from "./stylometric/types";
export { CATEGORY_PRIORITY } from "./stylometric/types";

export {
  acceptStyleSuggestion,
  applyAllStyleSuggestions,
  dismissAllStyleSuggestions,
  dismissStyleSuggestion,
} from "./style-handlers";
export type { StyleHandlerDeps, StyleSuggestionStatus } from "./style-handlers";
