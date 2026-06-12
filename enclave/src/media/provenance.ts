import { createHash } from "node:crypto";
import {
  canonicaliseStableJson,
  MediaProvenanceRecordSchema,
  type MediaHandleKind,
  type MediaOrigin,
  type MediaProvenanceRecord,
} from "@calypso/chat-types";

export interface ProvenanceSigner {
  sign(canonical: string): string;
  verify(canonical: string, signatureB64: string): boolean;
}

interface CreateProvenanceInput {
  handleId: string;
  kind: MediaHandleKind;
  origin: MediaOrigin;
  providerVisible: boolean;
  sourceHandleIds: string[];
  createdBy: string;
  createdAt: Date;
  ttlSeconds: number;
  byteSize: number;
  bytes: Uint8Array;
}

interface DeriveProvenanceInput {
  handleId: string;
  kind: MediaHandleKind;
  providerVisible: boolean;
  sourceRecords: MediaProvenanceRecord[];
  createdBy: string;
  createdAt: Date;
  ttlSeconds: number;
  byteSize: number;
  bytes: Uint8Array;
}

export function createProvenanceRecord(
  input: CreateProvenanceInput,
  signer: ProvenanceSigner,
): MediaProvenanceRecord {
  const unsigned = {
    handleId: input.handleId,
    kind: input.kind,
    origin: input.origin,
    providerVisible: input.providerVisible,
    sourceHandleIds: input.sourceHandleIds,
    createdBy: input.createdBy,
    createdAt: input.createdAt.toISOString(),
    ttlSeconds: input.ttlSeconds,
    byteSize: input.byteSize,
    sha256: sha256Hex(input.bytes),
  };
  return MediaProvenanceRecordSchema.parse({
    ...unsigned,
    signature: signer.sign(canonicaliseStableJson(unsigned)),
  });
}

export function deriveProvenanceRecord(
  input: DeriveProvenanceInput,
  signer: ProvenanceSigner,
): MediaProvenanceRecord {
  const privateTainted = input.sourceRecords.some((record) =>
    record.origin === "user_private" || record.origin === "generated_from_private",
  );
  return createProvenanceRecord(
    {
      handleId: input.handleId,
      kind: input.kind,
      origin: privateTainted ? "generated_from_private" : "generated",
      providerVisible: input.providerVisible,
      sourceHandleIds: input.sourceRecords.map((record) => record.handleId).sort(),
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      ttlSeconds: input.ttlSeconds,
      byteSize: input.byteSize,
      bytes: input.bytes,
    },
    signer,
  );
}

export function verifyProvenanceRecord(
  record: MediaProvenanceRecord,
  bytes: Uint8Array,
  signer: ProvenanceSigner,
  now: Date,
): boolean {
  const parsed = MediaProvenanceRecordSchema.safeParse(record);
  if (!parsed.success) return false;
  const expiresAt =
    new Date(parsed.data.createdAt).getTime() + parsed.data.ttlSeconds * 1000;
  if (now.getTime() > expiresAt) return false;
  if (sha256Hex(bytes) !== parsed.data.sha256) return false;
  const { signature, ...unsigned } = parsed.data;
  return signer.verify(canonicaliseStableJson(unsigned), signature);
}

export function classifyProvenanceSet(records: readonly MediaProvenanceRecord[]): {
  taint: "public_or_generated" | "private";
  providerVisible: boolean;
} {
  const privateTainted = records.some((record) =>
    record.origin === "user_private" || record.origin === "generated_from_private",
  );
  return {
    taint: privateTainted ? "private" : "public_or_generated",
    providerVisible: records.some((record) => record.providerVisible),
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
