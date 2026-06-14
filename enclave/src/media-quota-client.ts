/**
 * Enclave-side client for the host media-quota broker (hard metering).
 *
 * The orchestrator's media budgetClient cannot call the server's session-authed
 * /media-quota route directly (the enclave holds no user session). It instead
 * issues a line-framed JSON RPC over AF_VSOCK to a host-local media-quota broker
 * (infra/host/media-quota-broker.py), which forwards it to the server's
 * service-authed internal endpoints carrying the explicit userId/planId the
 * enclave received in the authenticated AGENT_REQUEST envelope.
 *
 * Protocol (mirrors keys-client.ts, but request/response): open vsock, write
 * `<json>\n`, read the JSON reply, parse. FAIL CLOSED: any transport / parse
 * failure resolves to `{ ok: false }` so a reserve never silently permits
 * unmetered generation, and a reconcile failure is surfaced (the caller's
 * best-effort settlement + the server-side hold TTL bound the leak).
 */
import { Buffer } from 'node:buffer';
import {
  encodeMediaBudgetRequest,
  decodeMediaBudgetReserveResult,
  decodeMediaBudgetReconcileResult,
  MAX_MEDIA_BUDGET_RPC_BYTES,
  type MediaBudgetReserveRequest,
  type MediaBudgetReconcileRequest,
  type MediaBudgetReserveResult,
  type MediaBudgetReconcileResult,
} from '@calypso/chat-types';

const VSOCK_CID_PARENT = 3;
const MEDIA_QUOTA_BROKER_PORT = parseInt(
  // 8104: 8100 cred, 8101 registry, 8102 keys, 8103 skills-prompts are taken.
  process.env.MEDIA_QUOTA_BROKER_PORT ?? '8104',
  10,
);
const RPC_TIMEOUT_MS = 5_000;
// Response cap mirrors the request cap with headroom; the reply is a tiny JSON.
const MAX_RESPONSE_BYTES = MAX_MEDIA_BUDGET_RPC_BYTES;

export const MEDIA_QUOTA_BROKER_UNREACHABLE = 'MEDIA_QUOTA_BROKER_UNREACHABLE';
export const MEDIA_QUOTA_BROKER_MALFORMED = 'MEDIA_QUOTA_BROKER_MALFORMED';

export async function reserveMediaBudget(
  req: MediaBudgetReserveRequest,
): Promise<MediaBudgetReserveResult> {
  try {
    const responseBytes = await sendBudgetRpc(encodeMediaBudgetRequest(req));
    return decodeMediaBudgetReserveResult(responseBytes);
  } catch (err) {
    // FAIL CLOSED — a reserve we cannot confirm must block generation.
    return { ok: false, reason: brokerReason(err) };
  }
}

export async function reconcileMediaBudget(
  req: MediaBudgetReconcileRequest,
): Promise<MediaBudgetReconcileResult> {
  try {
    const responseBytes = await sendBudgetRpc(encodeMediaBudgetRequest(req));
    return decodeMediaBudgetReconcileResult(responseBytes);
  } catch (err) {
    return { ok: false, reason: brokerReason(err) };
  }
}

function brokerReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(MEDIA_QUOTA_BROKER_MALFORMED)
    ? MEDIA_QUOTA_BROKER_MALFORMED
    : MEDIA_QUOTA_BROKER_UNREACHABLE;
}

async function sendBudgetRpc(requestBytes: Buffer): Promise<Buffer> {
  let vsock: typeof import('@calypso/vsock-native');
  try {
    vsock = (await import(
      '@calypso/vsock-native' as string
    )) as typeof import('@calypso/vsock-native');
  } catch (err) {
    throw new Error(
      `${MEDIA_QUOTA_BROKER_UNREACHABLE}: @calypso/vsock-native import failed: ${(err as Error).message}`,
    );
  }

  return new Promise<Buffer>((resolve, reject) => {
    let socket: ReturnType<typeof vsock.connect>;
    try {
      socket = vsock.connect(MEDIA_QUOTA_BROKER_PORT, VSOCK_CID_PARENT);
    } catch (err) {
      reject(new Error(`${MEDIA_QUOTA_BROKER_UNREACHABLE}: ${(err as Error).message}`));
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(
        new Error(
          `${MEDIA_QUOTA_BROKER_UNREACHABLE}: media-quota broker on vsock:${VSOCK_CID_PARENT}:${MEDIA_QUOTA_BROKER_PORT} timed out`,
        ),
      );
    }, RPC_TIMEOUT_MS);

    socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_RESPONSE_BYTES) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        reject(
          new Error(
            `${MEDIA_QUOTA_BROKER_MALFORMED}: oversized response (${received} bytes, max ${MAX_RESPONSE_BYTES})`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const bytes = Buffer.concat(chunks);
      if (bytes.length === 0) {
        reject(new Error(`${MEDIA_QUOTA_BROKER_UNREACHABLE}: empty response`));
        return;
      }
      resolve(bytes);
    });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`${MEDIA_QUOTA_BROKER_UNREACHABLE}: closed before response`));
    });
    socket.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`${MEDIA_QUOTA_BROKER_UNREACHABLE}: ${err.message}`));
    });

    // Newline-framed request, mirroring the cred-broker reply convention.
    socket.write(Buffer.concat([requestBytes, Buffer.from('\n')]));
  });
}
