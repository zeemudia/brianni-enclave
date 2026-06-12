import {
  VideoCompositionSpecSchema,
  type MediaProvenanceRecord,
  type VideoCompositionSpec,
} from "@calypso/chat-types";
import { verifyProvenanceRecord, type ProvenanceSigner } from "./provenance";

export interface MediaHandleStore {
  getBytes(handleId: string): Promise<Uint8Array | null>;
  getText(handleId: string): Promise<string | null>;
}

export async function validateVideoCompositionAgainstProvenance(input: {
  spec: unknown;
  recordsByHandleId: Map<string, MediaProvenanceRecord>;
  handleStore: MediaHandleStore;
  signer: ProvenanceSigner;
  now: Date;
}): Promise<
  { ok: true; spec: VideoCompositionSpec; records: MediaProvenanceRecord[] } | { ok: false; reason: string }
> {
  const parsed = VideoCompositionSpecSchema.safeParse(input.spec);
  if (!parsed.success) return { ok: false, reason: "VIDEO_COMPOSITION_SPEC_INVALID" };
  const handleIds = collectHandleIds(parsed.data);
  const records: MediaProvenanceRecord[] = [];
  for (const handleId of handleIds) {
    const record = input.recordsByHandleId.get(handleId);
    if (!record) return { ok: false, reason: `UNKNOWN_MEDIA_HANDLE:${handleId}` };
    for (const parentHandleId of record.sourceHandleIds) {
      if (!input.recordsByHandleId.has(parentHandleId)) {
        return { ok: false, reason: `UNKNOWN_MEDIA_PARENT_HANDLE:${parentHandleId}` };
      }
    }
    const bytes = await input.handleStore.getBytes(handleId);
    if (!bytes) return { ok: false, reason: `MEDIA_HANDLE_BYTES_MISSING:${handleId}` };
    if (!verifyProvenanceRecord(record, bytes, input.signer, input.now)) {
      return { ok: false, reason: `MEDIA_PROVENANCE_INVALID:${handleId}` };
    }
    records.push(record);
  }
  return { ok: true, spec: parsed.data, records };
}

function collectHandleIds(spec: VideoCompositionSpec): Set<string> {
  const handles = new Set(spec.assets.map((asset) => asset.handleId));
  for (const scene of spec.scenes) {
    for (const layer of scene.layers) {
      if (layer.type === "text" || layer.type === "caption") handles.add(layer.textHandleId);
    }
  }
  return handles;
}
