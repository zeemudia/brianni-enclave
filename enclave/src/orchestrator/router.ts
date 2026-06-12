import type {
  AgentSubtask,
  ModelCapability,
  ModelEndpointFamily,
  ModelRouteDecision,
  ModelStrength,
  ToolName,
} from '@calypso/chat-types';

const COST_SCORE = { low: 3, medium: 2, high: 1 } as const;
const LATENCY_SCORE = { fast: 3, standard: 2, slow: 1 } as const;
const QUALITY_SCORE = {
  basic: 1,
  standard: 4,
  strong: 7,
  frontier: 10,
} as const;
const QUALITY_SENSITIVE_KINDS = new Set([
  'planning',
  'reasoning',
  'writing',
  'code',
  'synthesis',
]);
// Hard capabilities are modality- or endpoint-bearing for provider routing.
// A model must match them unless the subtask's own scoped local tool performs
// that bounded modality operation (OCR, transcription, or copy-on-write
// transform). Everything else (writing, code, planning, fast_reasoning,
// long_context, …) is a soft preference describing a quality or speed *axis*
// that any capable chat model can attempt — these are ranked, not required.
// Strict superset matching across BOTH kinds previously made legitimate
// planner combos like ['writing','fast_reasoning'] unroutable, because the
// catalog deliberately keeps the speed axis (fast_reasoning) on small models
// and the content axes on the frontier models, so no single model held both.
// `moderation` is deliberately NOT hard: a content-safety / policy judgment is
// something any chat model performs in-context, not a provider endpoint. Leaving
// it hard made the planner's common "assess request against policy" subtask
// (labelled requiredCapabilities:['moderation']) unroutable — no enabled chat
// model carries a 'moderation' strength — so it dead-ended in NO_MODEL_FOR_SUBTASK
// and skipped its dependent report. Treat it as a soft preference instead.
const HARD_CAPABILITIES = new Set<ModelStrength>([
  'image_generation',
  'video_generation',
  'audio_generation',
  'speech_to_text',
  'embedding',
  'vision',
  'computer_use',
]);
// Local media tool families. Every tool in a family performs that family's
// bounded modality work LOCALLY (in-enclave / on-device), so a chat model only
// needs to DRIVE the tool — it never needs the provider-modality strength. A
// subtask carrying ANY tool from a family therefore satisfies EVERY hard
// modality capability that family can serve, regardless of which (often
// imprecise) capability the LLM planner labelled it with. This is the key
// robustness property: the planner routinely tags an image-resize subtask
// 'vision' while scoping only image.transform — the old exact (cap→tool) map
// left that unroutable (NO_MODEL_FOR_SUBTASK) even though a local tool does the
// work. A genuine provider-only modality with NO local family tool (e.g.
// image.generate / audio.speech gateway tools, or no tool at all) still fails
// closed — a chat model must not fake a provider generation it cannot perform.
const LOCAL_MODALITY_TOOL_FAMILIES: ReadonlyArray<{
  readonly tools: readonly ToolName[];
  readonly satisfies: readonly ModelStrength[];
}> = [
  {
    tools: ['image.inspect', 'image.ocr', 'image.transform'],
    satisfies: ['vision', 'image_generation'],
  },
  {
    tools: ['audio.inspect', 'audio.transcribe', 'audio.transform'],
    satisfies: ['speech_to_text', 'audio_generation'],
  },
  {
    // video.transform can derive an audio file too (e.g. "extract the audio
    // track to .m4a"), which the planner routinely labels 'audio_generation'.
    // Without it here that subtask dead-ended in NO_MODEL_FOR_SUBTASK even
    // though video.transform does the work locally (live A14 gap on 97cc3994).
    tools: ['video.inspect', 'video.transcribe', 'video.transform'],
    satisfies: ['vision', 'speech_to_text', 'video_generation', 'audio_generation'],
  },
];
export interface ModelRoutingOptions {
  enabledGatewayTools?: readonly string[];
  enabledEndpointFamilies: readonly ModelEndpointFamily[];
}

export function selectModelForSubtask(
  subtask: AgentSubtask,
  models: readonly ModelCapability[],
  opts: ModelRoutingOptions,
): ModelRouteDecision {
  const enabledGatewayTools = new Set(opts.enabledGatewayTools ?? []);
  const enabledEndpointFamilies = new Set<ModelEndpointFamily>(
    opts.enabledEndpointFamilies,
  );
  const scored = models
    .filter((model) => model.routingStatus === 'enabled')
    .filter((model) => enabledEndpointFamilies.has(model.endpointFamily))
    .filter((model) =>
      model.requiredGatewayTools.every((tool) => enabledGatewayTools.has(tool)),
    )
    .map((model) => ({
      model,
      score: scoreModel(subtask, model),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.model.modelId.localeCompare(b.model.modelId),
    );

  const best = scored[0];
  if (!best) {
    throw new Error(`NO_MODEL_FOR_SUBTASK:${subtask.id}`);
  }

  return {
    subtaskId: subtask.id,
    modelId: best.model.modelId,
    providerId: best.model.providerId,
    reason: `Matched ${subtask.requiredCapabilities.join(', ')} for ${subtask.kind}.`,
    fallbackModelIds: providerDiverseFallbackModelIds(scored),
  };
}

function providerDiverseFallbackModelIds(
  scored: ReadonlyArray<{ model: ModelCapability; score: number }>,
): string[] {
  const primary = scored[0]?.model;
  if (!primary) return [];

  const buckets = new Map<string, ModelCapability[]>();
  for (const entry of scored.slice(1)) {
    const bucket = buckets.get(entry.model.providerId) ?? [];
    bucket.push(entry.model);
    buckets.set(entry.model.providerId, bucket);
  }

  const providerOrder = [...buckets.keys()].filter(
    (providerId) => providerId !== primary.providerId,
  );
  if (buckets.has(primary.providerId)) providerOrder.push(primary.providerId);

  const out: string[] = [];
  while (out.length < 4) {
    let added = false;
    for (const providerId of providerOrder) {
      const next = buckets.get(providerId)?.shift();
      if (!next) continue;
      out.push(next.modelId);
      added = true;
      if (out.length >= 4) break;
    }
    if (!added) break;
  }
  return out;
}

function scoreModel(subtask: AgentSubtask, model: ModelCapability): number {
  const required = subtask.requiredCapabilities;
  const strengths = new Set(model.strengths);

  // Hard gate: every modality/endpoint-bearing capability not supplied by a
  // scoped local tool MUST be present, or the model is disqualified (score 0).
  // This keeps provider modality routing fail-closed while allowing chat
  // workers to call bounded local media tools.
  const hardRequired = required.filter((capability) =>
    HARD_CAPABILITIES.has(capability),
  );
  const modelHardRequired = hardRequired.filter(
    (capability) => !isHardCapabilitySatisfiedByTool(capability, subtask),
  );
  if (!modelHardRequired.every((capability) => strengths.has(capability))) return 0;

  // Soft capabilities are preferences: reward models that cover more of them
  // and at higher quality, but never disqualify a model for missing one. A
  // model that clears the hard gate is always selectable, so a speed/quality
  // preference can no longer make a content task unroutable.
  const softRequired = required.filter(
    (capability) => !HARD_CAPABILITIES.has(capability),
  );
  const matchedSoft = softRequired.filter((capability) =>
    strengths.has(capability),
  );

  const qualityByStrength = new Map(
    model.strengthQuality.map((entry) => [entry.strength, entry.tier]),
  );
  const quality = [...modelHardRequired, ...matchedSoft].reduce(
    (sum, capability) =>
      sum + QUALITY_SCORE[qualityByStrength.get(capability) ?? 'standard'],
    0,
  );
  // Coverage rewards matching the requested capabilities; hard caps are always
  // matched here (the gate guaranteed it). Missing soft caps simply earn no
  // coverage rather than disqualifying the model.
  const coverage = (hardRequired.length + matchedSoft.length) * 10;
  const context = model.maxContextTokens && model.maxContextTokens >= 1_000_000 ? 3 : 0;
  const utility = COST_SCORE[model.costTier] + LATENCY_SCORE[model.latencyTier];
  const qualityWeight = QUALITY_SENSITIVE_KINDS.has(subtask.kind) ? 4 : 2;
  const utilityWeight = QUALITY_SENSITIVE_KINDS.has(subtask.kind) ? 1 : 3;

  // Base of 1 keeps a model that clears the hard gate but matches no soft
  // capability strictly positive, so selectModelForSubtask's `score > 0`
  // filter still finds it as a last resort instead of dead-ending.
  return 1 + coverage + quality * qualityWeight + utility * utilityWeight + context;
}

function isHardCapabilitySatisfiedByTool(
  capability: ModelStrength,
  subtask: AgentSubtask,
): boolean {
  return LOCAL_MODALITY_TOOL_FAMILIES.some(
    (family) =>
      family.satisfies.includes(capability) &&
      family.tools.some((tool) => subtask.allowedTools.includes(tool)),
  );
}
