import { createHash } from "node:crypto";
import type { MediaProvenanceRecord } from "@calypso/chat-types";
import { classifyProvenanceSet, verifyProvenanceRecord, type ProvenanceSigner } from "./provenance";
import type { MediaHandleStore } from "./composition-spec";

export async function prepareProviderVisibleInput(input: {
  promptHandleId: string;
  inputHandleIds: string[];
  recordsByHandleId: Map<string, MediaProvenanceRecord>;
  handleStore: MediaHandleStore;
  signer: ProvenanceSigner;
  now: Date;
}): Promise<
  | {
      ok: true;
      promptText: string;
      inputImageBytes?: Uint8Array;
      privateTainted: boolean;
      inputHandleSetHash: string;
      provenanceSnapshotHash: string;
    }
  | { ok: false; reason: string }
> {
  const handleIds = [input.promptHandleId, ...input.inputHandleIds].sort();
  const records: MediaProvenanceRecord[] = [];
  for (const handleId of handleIds) {
    const record = input.recordsByHandleId.get(handleId);
    if (!record) return { ok: false, reason: `UNKNOWN_PROVIDER_INPUT_HANDLE:${handleId}` };
    const bytes = await input.handleStore.getBytes(handleId);
    if (!bytes) return { ok: false, reason: `PROVIDER_INPUT_BYTES_MISSING:${handleId}` };
    if (!verifyProvenanceRecord(record, bytes, input.signer, input.now)) {
      return { ok: false, reason: `PROVIDER_INPUT_PROVENANCE_INVALID:${handleId}` };
    }
    records.push(record);
  }
  const promptText = await input.handleStore.getText(input.promptHandleId);
  if (!promptText) return { ok: false, reason: "PROVIDER_PROMPT_TEXT_MISSING" };
  const firstImageHandle = records.find((record) => record.kind === "image")?.handleId;
  const inputImageBytes = firstImageHandle ? await input.handleStore.getBytes(firstImageHandle) : undefined;
  const provenanceSnapshotHash = createHash("sha256")
    .update(
      JSON.stringify(
        records
          .map((record) => ({ handleId: record.handleId, sha256: record.sha256, signature: record.signature }))
          .sort((a, b) => a.handleId.localeCompare(b.handleId)),
      ),
    )
    .digest("hex");
  return {
    ok: true,
    promptText,
    inputImageBytes: inputImageBytes ?? undefined,
    privateTainted: classifyProvenanceSet(records).taint === "private",
    inputHandleSetHash: provenanceSnapshotHash,
    provenanceSnapshotHash,
  };
}
