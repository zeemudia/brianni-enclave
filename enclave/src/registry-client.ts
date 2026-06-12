/**
 * Fetches the signed provider registry JSON from the host-side
 * registry-broker (infra/host/registry-broker.py) over AF_VSOCK.
 *
 * Keeping the registry out of the EIF is what makes "add a provider that
 * uses an existing adapter" a config-only change (no PCR0 rotation). The
 * integrity guarantee is provided by the Ed25519 signature check in
 * packages/masking-core/registry — a compromised host can pass any bytes
 * to the enclave, but only a bundle signed with the offline registry
 * signing key verifies successfully.
 */
import { Buffer } from 'node:buffer';

const VSOCK_CID_PARENT = 3;
const REGISTRY_BROKER_PORT = parseInt(
  process.env.REGISTRY_BROKER_PORT ?? '8101',
  10,
);
const FETCH_TIMEOUT_MS = 5_000;
// Hard cap on broker response size (mirrors keys-client.ts). The committed
// signed registry is ~20 KB (3 providers with full model capability
// metadata); 256 KB is >10× headroom for schema growth and bounds the heap
// exposure if a malicious or misbehaving host streams unbounded bytes
// before the 5 s timeout fires. Without this cap, the 'data' handler
// would accumulate chunks into memory until OOM — at boot, before the
// registry signature check ever runs.
const MAX_BLOB_BYTES = 256 * 1024;

/**
 * Open a vsock connection to the host-side registry-broker, read the
 * signed providers.json bytes, and return them as a UTF-8 string.
 *
 * Throws if the broker is unreachable, times out, or returns an empty
 * payload. Signature verification happens in the caller (initRegistry).
 */
export async function fetchRegistryFromBroker(): Promise<string> {
  // Lazy-import vsock-native: the native addon lives in a platform-specific
  // location inside the EIF and isn't available in dev/test. Deferring the
  // import keeps the module loadable under MOCK_KMS/NODE_ENV=test paths.
  let vsock: typeof import('@calypso/vsock-native');
  try {
    vsock = (await import(
      '@calypso/vsock-native' as string
    )) as typeof import('@calypso/vsock-native');
  } catch (err) {
    throw new Error(
      `registry-broker fetch requires @calypso/vsock-native ` +
        `(import failed: ${(err as Error).message})`,
    );
  }

  return new Promise<string>((resolve, reject) => {
    let socket: ReturnType<typeof vsock.connect>;
    try {
      socket = vsock.connect(REGISTRY_BROKER_PORT, VSOCK_CID_PARENT);
    } catch (err) {
      reject(new Error(`registry-broker connection failed: ${(err as Error).message}`));
      return;
    }

    const timeout = setTimeout(() => {
      socket.destroy(new Error('registry-broker timeout'));
      reject(
        new Error(
          `registry-broker on vsock:${VSOCK_CID_PARENT}:${REGISTRY_BROKER_PORT} timed out`,
        ),
      );
    }, FETCH_TIMEOUT_MS);

    const chunks: Buffer[] = [];
    let received = 0;

    socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BLOB_BYTES) {
        clearTimeout(timeout);
        socket.destroy();
        reject(
          new Error(
            `registry-broker oversized payload (received ${received} bytes, max ${MAX_BLOB_BYTES})`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', () => {
      clearTimeout(timeout);
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw.length === 0) {
        return reject(new Error('registry-broker returned empty payload'));
      }
      resolve(raw);
    });
    socket.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`registry-broker connection failed: ${err.message}`));
    });
  });
}
