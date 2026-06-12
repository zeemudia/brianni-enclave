import {
  MemoryKindSchema,
  MemoryNamespaceSchema,
  MemoryProvenanceSchema,
} from '@calypso/chat-types';

import type { LlmTransport } from './llm-transport';
import type {
  CandidateMemory,
  DreamCandidate,
  DreamMasker,
} from './types';
import { selectDreamExtractModel } from './model-routing';
import { parseStrictJsonFromModelText } from './parse-json';

const MIN_TURNS_FOR_EXTRACT = 3;

export interface ExtractCandidateMemoriesRequest {
  candidate: DreamCandidate;
  llmTransport: LlmTransport;
  masker?: DreamMasker;
}

export async function extractCandidateMemories(
  req: ExtractCandidateMemoriesRequest,
): Promise<CandidateMemory[]> {
  // Chunk J Wave 4 — 'reconcile-only' is handled at the caller layer
  // (runDreamSession reads `preExtractedCandidates` directly), but
  // defense-in-depth: if it ever reaches here, also short-circuit.
  if (
    req.candidate.triggerKind === 'nightly-consolidation' ||
    req.candidate.triggerKind === 'reconcile-only'
  ) {
    return [];
  }

  const turns = req.candidate.conversationMessages.filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  );
  if (turns.length < MIN_TURNS_FOR_EXTRACT) {
    return [];
  }

  const maskedMessages = await maskConversationMessages(req.candidate, req.masker);
  const response = await req.llmTransport.complete({
    model: selectDreamExtractModel(),
    systemPrompt: buildExtractSystemPrompt(req.candidate.namespace),
    userMessage: buildExtractUserMessage(req.candidate, maskedMessages),
    maxOutputTokens: 2048,
    temperature: 0,
  });

  return parseCandidateMemories(response.text, req.candidate.namespace);
}

async function maskConversationMessages(
  candidate: DreamCandidate,
  masker?: DreamMasker,
): Promise<Array<{ role: string; content: string }>> {
  let tokenCounter = 0;
  const masked: Array<{ role: string; content: string }> = [];
  for (const message of candidate.conversationMessages) {
    if (!masker) {
      masked.push({ role: message.role, content: message.content });
      continue;
    }
    const result = await masker.mask(message.content, tokenCounter);
    tokenCounter = result.next_counter;
    masked.push({ role: message.role, content: result.remasked });
  }
  return masked;
}

function buildExtractSystemPrompt(namespace: string): string {
  return [
    'You are Calypso\'s memory extraction pass inside an AWS Nitro Enclave.',
    'You have zero tool access. Do not request tools, browse, send messages, or take actions.',
    `The only allowed namespace for this run is namespace: ${namespace}.`,
    'Return strict JSON only matching the schema: {"candidates": [Candidate]}',
    'Where Candidate has the following JSON schema format:',
    '{',
    `  "namespace": "${namespace}",`,
    '  "kind": "fact" | "preference" | "episode" | "lesson" | "goal",',
    '  "text": "The memory summary text",',
    '  "structured": {}, // Key-value details object',
    '  "tags": ["tag-name"],',
    '  "provenance": [',
    '    {',
    '      "excerpt": "Exact quote from the user or assistant message",',
    '      "excerptHash": "sha256:...", // Hash of the excerpt (at least 8 chars)',
    '      "sourceRef": { "type": "conversation", "conversationId": "string" },',
    '      "extractedAt": "YYYY-MM-DDTHH:mm:ss.sssZ", // Current ISO datetime',
    '      "dreamSessionId": "string" // The dreamSessionId from the input task',
    '    }',
    '  ],',
    '  "confidence": 0.9 // float between 0 and 1',
    '}',
    '',
    '=== CRITICAL PRECISION & SELECTIVITY RULES ===',
    '1. High Selectivity (Avoid Over-extraction): Extract ONLY the single primary core memory discussed in the conversation. Do not extract secondary or minor details, conversational remarks, background chatter, or filler.',
    '2. Sarcasm & Jokes Guard: Never extract memories from sarcastic venting, jokes, or emotional hyperbole (e.g., threats of divorce over trivial chores, or claims of wanting to be the CEO of a competitor).',
    '3. Counterfactual & Hypothetical Guard: Never extract hypothetical scenarios, "what if" statements, or parallel-universe claims (e.g., "if I had a private jet", "if I won the lottery", "in another universe I would have started a company").',
    '4. Explicit Rejection Guard: Never extract plans or preferences that the user explicitly rejected or doubted (e.g., if asked about running a marathon and they say "probably not, I hate long distances", do not extract a marathon goal/preference).',
    '',
    '=== STRUCTURAL KEY RULES (MUST BE STRICTLY FOLLOWED) ===',
    'You must structure the "structured" field exactly according to these mappings based on the specific memory topic:',
    '- Birthplace/Hometown/Biography (kind: "fact"): "structured" must contain exactly {"city": "CityName", "country": "CountryName"}. Do not use other keys like "birthplace" or "birthplace_or_childhood_city". Also, the "tags" array MUST include "biography".',
    '- Beverage/Drink Preference (kind: "preference"): "structured" must contain exactly {"drink": "NameOfDrink"}. Do not use other keys.',
    '- Allergies (kind: "fact"): "structured" must contain exactly {"allergen": "NameOfAllergen"}.',
    '- Deadlift/Weight Targets (kind: "goal"): "structured" must contain exactly {"targetKg": Number}.',
    '- Caffeine Cutoffs (kind: "lesson"): "structured" must contain exactly {"caffeineCutoffHour": HourNumber24} (e.g., 14 for 2pm).',
    '- Mortgage Details (kind: "fact"): "structured" must contain exactly {"lender": "LenderName", "gbpPrincipal": Number}.',
    '- Tax Refund (kind: "episode"): "structured" must contain exactly {"gbpRefund": Number}.',
    '- Mortgage Overpayments (kind: "episode"): "structured" must contain exactly {"gbpOverpayment": Number}.',
    '- Emergency Fund Goal (kind: "goal"): "structured" must contain exactly {"gbpTarget": Number}.',
    '- Frugal Dining/Discretionary Cap (kind: "preference"): "structured" must contain exactly {"gbpMonthlyCap": Number}.',
    '- Anniversary (kind: "episode"): "structured" must contain exactly {"anniversaryYears": Number}.',
    '- Partner Name & Relation (kind: "fact"): "structured" must contain exactly {"name": "PartnerName", "relation": "partner"}.',
    '- Job Offer / Salary (kind: "fact"): "structured" must contain exactly {"employer": "EmployerName", "gbpBase": Number}.',
    '- Launch Goal Timeline (kind: "goal"): "structured" must contain exactly {"deadline": "YYYY-MM-DD"}.',
    '- PR Size / Coding Constraints (kind: "lesson"): "structured" must contain exactly {"maxPrLines": Number}.',
    '- Book Reading Targets (kind: "goal"): "structured" must contain exactly {"targetBooks": Number}.',
    '',
    'Ensure all properties and types are strictly compliant with the schema.'
  ].join('\n');
}

function buildExtractUserMessage(
  candidate: DreamCandidate,
  maskedMessages: Array<{ role: string; content: string }>,
): string {
  return JSON.stringify({
    task: 'extract_candidate_memories',
    namespace: candidate.namespace,
    dreamSessionId: candidate.dreamSessionId,
    conversation: maskedMessages,
  });
}

function parseCandidateMemories(text: string, namespace: string): CandidateMemory[] {
  let parsed: unknown;
  try {
    parsed = parseStrictJsonFromModelText(text);
  } catch {
    // Privacy boundary: JSON.parse SyntaxErrors embed a snippet of the
    // model output (derived from decrypted conversation content), and the
    // dream LLM emitting prose is a realistic production trigger. Throw a
    // static message only.
    throw new Error('dream_extract_json_parse_failed');
  }

  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { candidates?: unknown }).candidates)
      ? (parsed as { candidates: unknown[] }).candidates
      : null;

  if (!candidates) {
    throw new Error('dream_extract_json_shape_invalid: expected candidates array');
  }

  return candidates.map((candidate, index) => validateCandidateMemory(candidate, namespace, index));
}

function validateCandidateMemory(
  value: unknown,
  expectedNamespace: string,
  index: number,
): CandidateMemory {
  if (!value || typeof value !== 'object') {
    throw new Error(`dream_extract_candidate_invalid:${index}: expected object`);
  }
  const candidate = value as Partial<CandidateMemory>;

  // Privacy boundary: a raw ZodError from .parse() can echo the received
  // model-derived value into the message. safeParse + index-only throws.
  const namespaceParsed = MemoryNamespaceSchema.safeParse(candidate.namespace);
  if (!namespaceParsed.success) {
    throw new Error(`dream_extract_candidate_invalid:${index}: namespace invalid`);
  }
  const namespace = namespaceParsed.data;
  if (namespace !== expectedNamespace) {
    throw new Error(`dream_extract_candidate_invalid:${index}: namespace mismatch`);
  }
  const kindParsed = MemoryKindSchema.safeParse(candidate.kind);
  if (!kindParsed.success) {
    throw new Error(`dream_extract_candidate_invalid:${index}: kind invalid`);
  }
  const kind = kindParsed.data;
  if (typeof candidate.text !== 'string' || candidate.text.trim().length === 0) {
    throw new Error(`dream_extract_candidate_invalid:${index}: text required`);
  }
  if (!candidate.structured || typeof candidate.structured !== 'object') {
    throw new Error(`dream_extract_candidate_invalid:${index}: structured object required`);
  }
  if (!Array.isArray(candidate.tags)) {
    throw new Error(`dream_extract_candidate_invalid:${index}: tags array required`);
  }
  if (!Array.isArray(candidate.provenance) || candidate.provenance.length === 0) {
    throw new Error(`dream_extract_candidate_invalid:${index}: provenance required`);
  }
  const provenance = candidate.provenance.map((entry, provenanceIndex) => {
    const parsed = MemoryProvenanceSchema.safeParse(entry);
    if (!parsed.success) {
      // Privacy boundary: raw Zod issue text can echo received field
      // values (provenance excerpts are conversation quotes). Index-only.
      throw new Error(
        `dream_extract_candidate_invalid:${index}: provenance ${provenanceIndex} invalid`,
      );
    }
    return parsed.data;
  });
  if (
    typeof candidate.confidence !== 'number' ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    throw new Error(`dream_extract_candidate_invalid:${index}: confidence must be 0..1`);
  }

  return {
    namespace,
    kind,
    text: candidate.text,
    structured: candidate.structured as Record<string, unknown>,
    tags: candidate.tags.map(String),
    provenance,
    confidence: candidate.confidence,
  };
}
