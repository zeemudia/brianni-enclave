/**
 * Enclave-side transport for the host video-checkpoint broker (durable store).
 *
 * The stateless enclave's orchestrator checkpointClient cannot call the server's
 * session-authed routes directly. It issues a line-framed JSON RPC over AF_VSOCK
 * to a host-local video-checkpoint broker (infra/host/video-checkpoint-broker.py,
 * vsock 8105), which forwards it to the server's service-authed internal endpoint.
 *
 * This module is the raw transport only: encode → open vsock → write `<json>\n`
 * → read the JSON reply bytes. It THROWS on any transport / timeout / oversized
 * failure; the higher-level store (video-checkpoint-store.ts) decides fail-closed
 * semantics per op (load/save throw to abort the subtask; the reconciler's own
 * try/catch handles list/terminal failures).
 */
import { Buffer } from 'node:buffer';
import {
  encodeVideoCheckpointRequest,
  MAX_VIDEO_CHECKPOINT_RPC_BYTES,
  type VideoCheckpointRequest,
} from '@calypso/chat-types';

const VSOCK_CID_PARENT = 3;
const VIDEO_CHECKPOINT_BROKER_PORT = parseInt(
  // 8105: 8100 cred, 8101 registry, 8102 keys, 8103 skills, 8104 media-quota are taken.
  process.env.VIDEO_CHECKPOINT_BROKER_PORT ?? '8105',
  10,
);
// JOIN-backed list ops are heavier than the quota RPC; allow more headroom.
const RPC_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = MAX_VIDEO_CHECKPOINT_RPC_BYTES;

export const VIDEO_CHECKPOINT_BROKER_UNREACHABLE = 'VIDEO_CHECKPOINT_BROKER_UNREACHABLE';
export const VIDEO_CHECKPOINT_BROKER_MALFORMED = 'VIDEO_CHECKPOINT_BROKER_MALFORMED';

export async function sendVideoCheckpointRpc(req: VideoCheckpointRequest): Promise<Buffer> {
  const requestBytes = encodeVideoCheckpointRequest(req);

  let vsock: typeof import('@calypso/vsock-native');
  try {
    vsock = (await import(
      '@calypso/vsock-native' as string
    )) as typeof import('@calypso/vsock-native');
  } catch (err) {
    throw new Error(
      `${VIDEO_CHECKPOINT_BROKER_UNREACHABLE}: @calypso/vsock-native import failed: ${(err as Error).message}`,
    );
  }

  return new Promise<Buffer>((resolve, reject) => {
    let socket: ReturnType<typeof vsock.connect>;
    try {
      socket = vsock.connect(VIDEO_CHECKPOINT_BROKER_PORT, VSOCK_CID_PARENT);
    } catch (err) {
      reject(new Error(`${VIDEO_CHECKPOINT_BROKER_UNREACHABLE}: ${(err as Error).message}`));
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
          `${VIDEO_CHECKPOINT_BROKER_UNREACHABLE}: video-checkpoint broker on vsock:${VSOCK_CID_PARENT}:${VIDEO_CHECKPOINT_BROKER_PORT} timed out`,
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
            `${VIDEO_CHECKPOINT_BROKER_MALFORMED}: oversized response (${received} bytes, max ${MAX_RESPONSE_BYTES})`,
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
        reject(new Error(`${VIDEO_CHECKPOINT_BROKER_UNREACHABLE}: empty response`));
        return;
      }
      resolve(bytes);
    });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`${VIDEO_CHECKPOINT_BROKER_UNREACHABLE}: closed before response`));
    });
    socket.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`${VIDEO_CHECKPOINT_BROKER_UNREACHABLE}: ${err.message}`));
    });

    // Newline-framed request, mirroring the media-quota broker convention.
    socket.write(Buffer.concat([requestBytes, Buffer.from('\n')]));
  });
}
