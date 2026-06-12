import { createHash, randomUUID } from "node:crypto";
import { TOMBSTONE_RECORD_SERIALISED_HASH } from "@calypso/chat-types";

import { extractCandidateMemories } from "./extract";
import type { LlmTransport } from "./llm-transport";
import {
  canonicaliseDreamRecord,
  reconcileCandidateMemories,
  type ReconciledDreamDelta,
} from "./reconcile";
import type { CandidateMemory, DreamCandidate } from "./types";

export {
  reconcileCandidateMemories,
  canonicaliseDreamRecord,
} from "./reconcile";
export { extractCandidateMemories } from "./extract";
export {
  finaliseDreamEnvelopes,
  canonicaliseEnvelopeForSigning,
} from "./envelope-sign";
export type { LlmTransport, LlmRequest, LlmResponse } from "./llm-transport";
export {
  AnthropicLlmTransport,
  RecordedLlmTransport as EnclaveRecordedLlmTransport,
} from "./llm-transport";
export type {
  CandidateMemory,
  DreamCandidate,
  DreamFinaliseResult,
  UnsignedEnvelope,
} from "./types";

export interface RunDreamSessionRequest {
  candidate: DreamCandidate;
  llmTransport?: LlmTransport;
  masker?: Parameters<typeof extractCandidateMemories>[0]["masker"];
}

export interface DreamSessionDeltaOutput extends ReconciledDreamDelta {
  deltaIndex: number;
  recordSerialisedHash: string;
}

export interface DreamSessionOutput {
  dreamSessionId: string;
  deltas: DreamSessionDeltaOutput[];
}

export async function runDreamSession(
  req: RunDreamSessionRequest,
): Promise<DreamSessionOutput> {
  // Codex LOW F13 — never fall back to process.env.ANTHROPIC_API_KEY. In
  // production the provider key is delivered only through attested KMS and the
  // router injects the resulting transport as req.llmTransport; an env-var
  // fallback would bypass the PCR0/KMS-bound key delivery (or silently send an
  // empty key). Fail closed if no transport was provided.
  const llmTransport = req.llmTransport;
  if (!llmTransport) {
    throw new Error(
      "DREAM: missing llmTransport — an attested KMS-backed provider transport is required (refusing env-key fallback)",
    );
  }
  // Chunk J Wave 4 — 'reconcile-only' skips the extract pass and runs
  // ONLY the reconcile pass over passed-in `preExtractedCandidates`.
  // Used by the contradiction-tab "Keep both" supersession path
  // which feeds the enclave a pre-built merged-record delta.
  const skipExtract =
    req.candidate.triggerKind === "nightly-consolidation" ||
    req.candidate.triggerKind === "reconcile-only";
  const candidates: CandidateMemory[] = skipExtract
    ? (req.candidate.preExtractedCandidates ?? [])
    : await extractCandidateMemories({
        candidate: req.candidate,
        llmTransport,
        masker: req.masker,
      });

  const reconciled = await reconcileCandidateMemories({
    candidates,
    existingMemoryRecords: req.candidate.existingMemoryRecords,
    context: {
      userId: req.candidate.userId,
      namespace: req.candidate.namespace,
      dreamSessionId: req.candidate.dreamSessionId,
    },
    llmTransport,
  });

  // R8 Finding B + R9 Finding A (Codex): every reconciled delta passes
  // through the shared canonicaliseMemoryRecord helper so the record
  // body that gets hashed and signed never contains a model-controlled
  // id, namespace, dreamSessionId, baseVersion, or provenance
  // attribution. The `mutationId` (signed replay/idempotency key) is
  // ALSO minted enclave-side per delta so a hostile or buggy model
  // cannot emit duplicate UUIDs that later collide at save time.
  // Errors propagate as `dream_reconcile_record_canonicalise_failed`
  // so the dream session aborts rather than signing an unsavable record.
  const dreamSessionId = req.candidate.dreamSessionId;
  const namespace = req.candidate.namespace;
  // Codex LOW F14 — non-ADD deltas must target a record that was actually part
  // of this reconcile context. The model's `targetId` is untrusted; ADD ids are
  // already minted enclave-side, but UPDATE/SUPERSEDE/TOMBSTONE previously
  // trusted the model's targetId "by contract". Without this guard a hostile
  // reconcile response could mutate/tombstone an arbitrary existing record for
  // the user (including one in another namespace) by emitting its id.
  const reconcileTargetIds = new Set(
    req.candidate.existingMemoryRecords.map((record) => record.id),
  );
  return {
    dreamSessionId,
    deltas: reconciled.map((delta, deltaIndex) => {
      if (
        delta.delta.action !== "ADD" &&
        !reconcileTargetIds.has(delta.delta.targetId)
      ) {
        // Error carries only the index — never the delta payload (host-
        // observable stderr; the delta can hold plaintext memory fields).
        throw new Error(`dream_reconcile_unknown_target:delta_${deltaIndex}`);
      }
      const enclaveMutationId = randomUUID();
      // R13 Finding C (Codex): mint blob ids enclave-side for ADD so
      // the LLM cannot pick a known id from another namespace and
      // cause `memory_blob_already_exists`. UPDATE/SUPERSEDE/TOMBSTONE
      // keep the model's targetId — it's the existing row's id by
      // contract.
      const enclaveTargetId =
        delta.delta.action === "ADD" ? randomUUID() : delta.delta.targetId;
      if (delta.delta.action === "TOMBSTONE" || delta.delta.record === null) {
        return {
          delta: {
            ...delta.delta,
            mutationId: enclaveMutationId,
            targetId: enclaveTargetId,
          },
          recordSerialised: "",
          deltaIndex,
          recordSerialisedHash: TOMBSTONE_RECORD_SERIALISED_HASH,
        };
      }
      const newRecordVersion =
        delta.delta.action === "ADD" ? 0 : delta.delta.expectedBaseVersion + 1;
      const canonical = canonicaliseDreamRecord(delta.delta.record, {
        blobId: enclaveTargetId,
        namespace,
        dreamSessionId,
        newRecordVersion,
        nowIso: new Date().toISOString(),
      });
      if (!canonical) {
        throw new Error(
          `dream_reconcile_record_canonicalise_failed:delta_${deltaIndex}`,
        );
      }
      return {
        delta: {
          ...delta.delta,
          record: canonical.record,
          mutationId: enclaveMutationId,
          targetId: enclaveTargetId,
        },
        deltaIndex,
        recordSerialised: canonical.recordSerialised,
        recordSerialisedHash: sha256Hex(canonical.recordSerialised),
      };
    }),
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
