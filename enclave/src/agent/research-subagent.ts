import {
  AgentRequestContextSchema,
  type AgentRequestContext,
  type ChatProcessor,
  type ResearchQuery,
  type SkillPack,
} from '@calypso/chat-types';

import type { ToolGateway } from '../tools';
import { runAgentLoop } from './loop';

/**
 * The canonical research-worker model. This is the registered model id
 * used by the provider factory (Task 2C.1: `deps.researchProviderFactory(RESEARCH_MODEL)`).
 * It must match a chat-endpointFamily model id in providers.json.
 * Import and pass this constant — do not hard-code the string at call sites.
 */
export const RESEARCH_MODEL = 'claude-haiku-4-5-20251001';

/** Wall-clock cap for a single research subagent turn. */
const RESEARCH_TIMEOUT_MS = 30_000;

/**
 * Maximum number of source URLs returned from a single research subagent run.
 * Bounds the sources list re-entering the parent model even if maxToolCalls
 * is later raised, preventing unbounded context injection.
 */
const MAX_RESEARCH_SOURCES = 8;

/**
 * The web-only skill pack for the air-gapped research subagent.
 * toolScopes: only web.fetch — no memory, no folder, no private access.
 * crossPackNamespaces: absent (no namespace widening).
 * linkedFolderScopes: empty (no folder access).
 *
 * The system prompt explicitly states the worker is web-only and must
 * not reference any private user data.
 */
const RESEARCH_WORKER_PACK: SkillPack = {
  id: 'personal-agent.research-worker',
  version: 1,
  displayName: 'Research Worker',
  description:
    'Air-gapped web-only research subagent. Answers questions from public web sources only.',
  systemPromptBlock:
    'You are a web researcher. Answer ONLY from public web sources. ' +
    'You have NO access to the user\'s private documents or memory. ' +
    'Return the facts you find and the source URLs. ' +
    'Do not ask for or use any private identifiers.',
  toolScopes: ['web.fetch'],
  capabilitySuiteIds: ['text'],
  defaultNamespace: 'default',
  linkedFolderScopes: {},
  uiHints: { icon: 'default', accentToken: 'accent-default' },
};

/**
 * Maximum number of characters in the research answer re-entering the parent model.
 * Bounds untrusted inbound content per spec §4.4.1.
 */
const MAX_RESEARCH_ANSWER_CHARS = 4000;

/**
 * Run an air-gapped research subagent that answers a single structured
 * research query using only public web sources.
 *
 * Security guarantees:
 * - The subagent runs on a sibling ToolGateway with a FRESH empty
 *   egress-taint ledger, no linked folders, no cross-pack grant, and
 *   strictEgressLock disabled — it cannot read any private
 *   namespace/folder data.
 * - RESEARCH_WORKER_PACK.toolScopes is ["web.fetch"] only: the gateway
 *   enforces OUT_OF_SCOPE for any other tool the model tries to call
 *   (including memory.read, folder.read, etc.).
 * - maxToolCalls: 4 caps the loop tightly; the provider is threaded
 *   from the dispatch context, not resolved inside this function.
 * - A RESEARCH_TIMEOUT_MS wall-clock AbortSignal is always applied so a
 *   stalled fetch cannot block the enclave turn indefinitely.
 *
 * @returns { answer, sources, failed } — answer is all text chunks emitted
 *   by the model during the turn (concatenated and trimmed); sources is the
 *   deduplicated list of URLs from SUCCESSFUL web.fetch calls only; failed is
 *   true if the loop threw (timeout abort / internal error) before completing.
 *
 *   AUDIT INVARIANT: the loop NEVER throws out of this function — a
 *   timeout/error is caught and the PARTIAL `sources` accumulated up to that
 *   point are still returned (with failed=true). This guarantees that any URL
 *   the air-gapped subagent ACTUALLY fetched is reported to the parent for the
 *   claims audit even when the subagent then fails post-fetch, so the receipt
 *   cannot under-report egress (privacy policy §19 / DPIA §5.5). `sources`
 *   still lists ONLY successful web.fetch URLs (the ev.outcome === 'ok' gate
 *   below is unchanged) — a failed run does not start recording attempts.
 */
export async function runResearchSubagent(input: {
  parentGateway: ToolGateway;
  query: ResearchQuery; // reserved for Phase 4 audit receipts (the structured query is recorded there)
  queryString: string;
  provider: ChatProcessor;
  requestContext?: AgentRequestContext;
  turnId: string;
}): Promise<{ answer: string; sources: string[]; failed: boolean }> {
  // 1. Spawn an air-gapped sibling gateway with a clean empty ledger and
  //    no private data access.
  const gw = input.parentGateway.createSiblingGateway({ linkedFolders: [] });

  // 2. Run the loop with a tight bound, collecting chunks and web.fetch URLs.
  let answer = '';
  const sources: string[] = [];

  // F1: Track the URL of the single in-flight web.fetch as a nullable scalar.
  // The agent loop is single-tool-in-flight, so at most one fetch is pending at
  // any time. A tool-invocation with a missing/empty URL clears the pending slot
  // (fails safe: drops the URL) rather than leaving a stale value that could be
  // misattributed to a later result. The pending slot is consumed (set to null)
  // on ANY web.fetch tool-result regardless of outcome.
  let pendingFetchUrl: string | null = null;

  // AUDIT INVARIANT: catch any throw from the loop (RESEARCH_TIMEOUT_MS abort,
  // provider/internal error) so the PARTIAL `sources` accumulated up to the
  // failure point are NOT discarded. They are returned (failed=true) and folded
  // into the parent's claims-audit set by the caller regardless of outcome —
  // otherwise a run that DID issue egress before failing would be recorded as
  // "no pages fetched", under-reporting what left the device.
  let failed = false;
  try {
    for await (const ev of runAgentLoop(
      {
        gateway: gw,
        provider: input.provider,
        pack: RESEARCH_WORKER_PACK,
        agentTurnId: input.turnId,
        maxToolCalls: 4,
        requestContext: AgentRequestContextSchema.parse({
          ...input.requestContext,
          linkedFolders: [],
        }),
        abortSignal: AbortSignal.timeout(RESEARCH_TIMEOUT_MS),
      },
      {
        messages: [{ role: 'user', content: input.queryString }],
        model: RESEARCH_MODEL,
      },
    )) {
      if (ev.kind === 'chunk') {
        answer += ev.text;
      } else if (
        ev.kind === 'tool-invocation' &&
        ev.frame.toolName === 'web.fetch'
      ) {
        // Set or CLEAR the pending URL. A missing/empty URL clears it so a later
        // result cannot misattribute the stale earlier URL.
        const url = (ev.frame.args as { url?: unknown }).url;
        pendingFetchUrl = typeof url === 'string' && url.length > 0 ? url : null;
      } else if (ev.kind === 'tool-result' && ev.toolName === 'web.fetch') {
        // Promote the pending URL to sources ONLY on a successful fetch result.
        // Consume the pending slot unconditionally (regardless of outcome).
        if (ev.outcome === 'ok' && pendingFetchUrl !== null) {
          sources.push(pendingFetchUrl);
        }
        pendingFetchUrl = null;
      }
    }
  } catch {
    // Timeout abort / internal failure mid-loop. Swallow the error: the partial
    // `answer` and (critically) the partial `sources` collected so far are
    // returned with failed=true. The caller decides the tool outcome.
    failed = true;
  }

  // F5: Cap answer length — bounds untrusted inbound content per spec §4.4.1.
  return {
    answer: answer.trim().slice(0, MAX_RESEARCH_ANSWER_CHARS),
    sources: [...new Set(sources)].slice(0, MAX_RESEARCH_SOURCES),
    failed,
  };
}
