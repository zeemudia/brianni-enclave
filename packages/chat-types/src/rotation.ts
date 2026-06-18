// Server-synthesized terminal SSE event emitted during a TEE rotation drain.
// NEVER produced inside the measured enclave (no PCR0/attestation implication).
// The server injects this event directly into the chat/agent SSE stream it owns.

import { z } from "zod";

export const RotationDrainEventSchema = z.object({
  _type: z.literal("rotation_drain"),
  retryAfterMs: z.number().int().nonnegative(),
  kind: z.enum(["chat", "agent"]),
});

export type RotationDrainEvent = z.infer<typeof RotationDrainEventSchema>;
