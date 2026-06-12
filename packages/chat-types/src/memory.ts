import { z } from 'zod';

export const MEMORY_NAMESPACES = [
  'default',
  'work',
  'money',
  'health',
  'relationships',
] as const;
export const MemoryNamespaceSchema = z.enum(MEMORY_NAMESPACES);
export type MemoryNamespace = (typeof MEMORY_NAMESPACES)[number];

export const MemoryKindSchema = z.enum([
  'fact',
  'preference',
  'episode',
  'lesson',
  'goal',
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemorySourceRefSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('conversation'),
    conversationId: z.string().min(1),
    messageIndex: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('file'),
    fileHandleAlias: z.string().min(1),
    fileContentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/i),
  }),
  z.object({
    type: z.literal('web'),
    urlHash: z.string().regex(/^sha256:[a-f0-9]{64}$/i),
    host: z.string().min(1).max(253),
  }),
]);
export type MemorySourceRef = z.infer<typeof MemorySourceRefSchema>;

export const MemoryProvenanceSchema = z.object({
  excerpt: z.string().min(1).max(2000),
  excerptHash: z.string().regex(/^sha256:[a-f0-9]{64}$/i).or(z.string().min(8)),
  sourceRef: MemorySourceRefSchema,
  extractedAt: z.string().datetime(),
  dreamSessionId: z.string().min(1),
});
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

export const MemoryRecordSchema = z.object({
  id: z.string().min(1),
  namespace: MemoryNamespaceSchema,
  baseVersion: z.number().int().nonnegative(),
  tombstoneEpoch: z.number().int().nonnegative(),
  dreamSessionId: z.string().min(1),
  kind: MemoryKindSchema,
  text: z.string().min(1).max(8000),
  structured: z.record(z.string(), z.unknown()),
  tags: z.array(z.string().max(64)).max(32),
  provenance: z.array(MemoryProvenanceSchema).min(1),
  confidence: z.number().min(0).max(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  supersededBy: z.string().nullable(),
  visibleToUser: z.boolean(),
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const DreamDeltaActionSchema = z.enum(['ADD', 'UPDATE', 'SUPERSEDE', 'TOMBSTONE']);
export type DreamDeltaAction = z.infer<typeof DreamDeltaActionSchema>;

export const DreamDeltaSchema = z
  .object({
    action: DreamDeltaActionSchema,
    targetId: z.string().min(1),
    record: MemoryRecordSchema.nullable(),
    expectedBaseVersion: z.number().int().min(-1),
    mutationId: z.string().uuid(),
  })
  .refine(
    (d) => (d.action === 'ADD' ? d.expectedBaseVersion === -1 : d.expectedBaseVersion >= 0),
    { message: 'ADD requires expectedBaseVersion=-1; non-ADD requires expectedBaseVersion>=0' },
  )
  .refine(
    (d) => (d.action === 'TOMBSTONE' ? d.record === null : d.record !== null),
    { message: 'TOMBSTONE requires record=null; non-TOMBSTONE requires record!=null' },
  );
export type DreamDelta = z.infer<typeof DreamDeltaSchema>;

export const SHA256_OF_EMPTY =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const TOMBSTONE_RECORD_SERIALISED_HASH = 'tombstone';

export const MemoryMutationEnvelopeSchema = z
  .object({
    v: z.literal(1),
    userId: z.string().min(1),
    namespace: MemoryNamespaceSchema,
    blobId: z.string().min(1),
    action: DreamDeltaActionSchema,
    expectedBaseVersion: z.number().int().min(-1),
    newRecordVersion: z.number().int().nonnegative(),
    kind: MemoryKindSchema,
    mutationId: z.string().uuid(),
    dreamSessionId: z.string().min(1),
    teeSessionId: z.string().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    recordSerialisedHash: z
      .string()
      .refine((v) => v === TOMBSTONE_RECORD_SERIALISED_HASH || /^[a-f0-9]{64}$/.test(v)),
    provenanceConversationIds: z.array(z.string().min(1)).max(64),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .superRefine((env, ctx) => {
    if (env.action === 'TOMBSTONE') {
      if (env.contentHash !== SHA256_OF_EMPTY) {
        ctx.addIssue({
          code: 'custom',
          path: ['contentHash'],
          message: 'TOMBSTONE requires contentHash === sha256(empty)',
        });
      }
      if (env.recordSerialisedHash !== TOMBSTONE_RECORD_SERIALISED_HASH) {
        ctx.addIssue({
          code: 'custom',
          path: ['recordSerialisedHash'],
          message: `TOMBSTONE requires recordSerialisedHash === '${TOMBSTONE_RECORD_SERIALISED_HASH}'`,
        });
      }
      return;
    }

    if (env.contentHash === SHA256_OF_EMPTY) {
      ctx.addIssue({
        code: 'custom',
        path: ['contentHash'],
        message: 'ADD/UPDATE/SUPERSEDE forbids contentHash === sha256(empty)',
      });
    }
    if (env.recordSerialisedHash === TOMBSTONE_RECORD_SERIALISED_HASH) {
      ctx.addIssue({
        code: 'custom',
        path: ['recordSerialisedHash'],
        message: 'ADD/UPDATE/SUPERSEDE forbids tombstone sentinel',
      });
    }
  });
export type MemoryMutationEnvelope = z.infer<typeof MemoryMutationEnvelopeSchema>;

export const MEMORY_ENVELOPE_HEADER = 'X-Calypso-Memory-Envelope';
export const MEMORY_SIGNATURE_HEADER = 'X-Calypso-Memory-Signature';
