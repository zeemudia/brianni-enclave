/**
 * Fetches the signed connector catalog JSON from the host-side
 * connectors-broker over AF_VSOCK. Mirrors registry-client.ts.
 *
 * Keeping the connector catalog out of the EIF is what makes "add or update
 * a connector" a config-only change (no PCR0 rotation). The integrity
 * guarantee is provided by the Ed25519 signature check in
 * enclave/src/connectors/registry.ts — a compromised host can pass any bytes
 * to the enclave, but only a bundle signed with the offline connector catalog
 * signing key verifies successfully.
 *
 * Vsock port: 8106 (connectors-broker). Phase-3 provisioning detail — the
 * host-side broker process is wired in Phase 3; this module is structurally
 * present in Phase 1 so index.ts can call it on the production boot path
 * without a second PCR0 rotation.
 */
import { Buffer } from 'node:buffer';

const VSOCK_CID_PARENT = 3;
const CONNECTORS_BROKER_PORT = parseInt(
  process.env.CONNECTORS_BROKER_PORT ?? '8106',
  10,
);
const FETCH_TIMEOUT_MS = 5_000;
// Hard cap on broker response size (mirrors registry-client.ts). 256 KB is
// >10× headroom for the connector catalog and bounds the heap exposure if a
// malicious or misbehaving host streams unbounded bytes before the timeout
// fires — at boot, before the signature check ever runs.
const MAX_BLOB_BYTES = 256 * 1024;

/**
 * Open a vsock connection to the host-side connectors-broker, read the
 * signed connectors.json bytes, and return them as a UTF-8 string.
 *
 * Throws if the broker is unreachable, times out, or returns an empty
 * payload. Signature verification happens in the caller (initConnectorRegistry).
 */
export async function fetchConnectorsFromBroker(): Promise<string> {
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
      `connectors-broker fetch requires @calypso/vsock-native ` +
        `(import failed: ${(err as Error).message})`,
    );
  }

  return new Promise<string>((resolve, reject) => {
    let socket: ReturnType<typeof vsock.connect>;
    try {
      socket = vsock.connect(CONNECTORS_BROKER_PORT, VSOCK_CID_PARENT);
    } catch (err) {
      reject(
        new Error(`connectors-broker connection failed: ${(err as Error).message}`),
      );
      return;
    }

    const timeout = setTimeout(() => {
      socket.destroy(new Error('connectors-broker timeout'));
      reject(
        new Error(
          `connectors-broker on vsock:${VSOCK_CID_PARENT}:${CONNECTORS_BROKER_PORT} timed out`,
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
            `connectors-broker oversized payload (received ${received} bytes, max ${MAX_BLOB_BYTES})`,
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
        return reject(new Error('connectors-broker returned empty payload'));
      }
      resolve(raw);
    });
    socket.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`connectors-broker connection failed: ${err.message}`));
    });
  });
}
