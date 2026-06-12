import { z } from 'zod';
import { MemoryNamespaceSchema } from './memory';

export const SIGNED_DELETION_JOB_KINDS = [
  'memory-single',
  'memory-bulk-by-ids',
  'memory-bulk-by-extractedAt',
  'memory-bulk-by-namespace',
  'forget-conversation-full',
] as const;

export const SignedDeletionJobKindSchema = z.enum(SIGNED_DELETION_JOB_KINDS);
export type SignedDeletionJobKind = z.infer<typeof SignedDeletionJobKindSchema>;

export const SignedDeletionItemSchema = z.object({
  blobId: z.string().min(1),
  blobKind: z.enum(['memory', 'conversation']),
});
export type SignedDeletionItem = z.infer<typeof SignedDeletionItemSchema>;

export const SignedDeletionRequestScopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('by-ids'),
    ids: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('by-extractedAt-before'),
    before: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('by-namespace'),
    namespace: MemoryNamespaceSchema,
  }),
  z.object({
    kind: z.literal('by-conversation-full'),
    conversationId: z.string().min(1),
  }),
]);
export type SignedDeletionRequestScope = z.infer<typeof SignedDeletionRequestScopeSchema>;

const SignedDeletionManifestObjectSchema = z.object({
  jobId: z.string().min(1),
  jobKind: SignedDeletionJobKindSchema,
  requestScope: SignedDeletionRequestScopeSchema,
  idempotencyKeyHash: z.string().regex(/^[a-f0-9]{64}$/, 'idempotencyKeyHash must be lowercase hex sha256'),
  items: z.array(SignedDeletionItemSchema).min(1),
  itemsCount: z.number().int().nonnegative(),
  highWaterMark: z.number().int().nonnegative(),
  iteration: z.number().int().min(1).optional(),
});

export const SignedDeletionManifestSchema = SignedDeletionManifestObjectSchema.refine(
  (m) => m.items.length === m.itemsCount,
  { message: 'itemsCount must match items.length' },
);
export type SignedDeletionManifest = z.infer<typeof SignedDeletionManifestSchema>;

const HybridFlatFieldsSchema = z.object({
  blobId: z.string().min(1),
  blobType: z.enum(['memory', 'conversation']),
  deletedAt: z.string().datetime(),
  contentHashAtDeletion: z.string().min(1),
  s3ObjectDeleted: z.literal(true),
  databaseRecordDeleted: z.literal(true),
});
export type HybridDeletionFlatFields = z.infer<typeof HybridFlatFieldsSchema>;

export const HybridSingleDeletionPayloadSchema = SignedDeletionManifestObjectSchema.merge(
  HybridFlatFieldsSchema,
).refine((m) => m.items.length === m.itemsCount, {
  message: 'itemsCount must match items.length',
});
export type HybridSingleDeletionPayload = z.infer<typeof HybridSingleDeletionPayloadSchema>;
