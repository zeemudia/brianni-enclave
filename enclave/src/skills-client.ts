/**
 * Fetches the signed skill-prompts bundle from the host-side skills-broker
 * (infra/host/skills-broker.py) over AF_VSOCK. Mirrors registry-client.ts.
 *
 * Keeping the persona prompts out of the EIF — and out of every client bundle —
 * is the IP-protection goal. The integrity guarantee is the Ed25519 signature
 * check in enclave/src/skills/verify-skill-prompts.ts: a compromised host can
 * stream any bytes to the enclave, but only a bundle signed with the offline
 * skill-prompts key (domain-separated from the provider registry) verifies.
 */
import { Buffer } from 'node:buffer';

const VSOCK_CID_PARENT = 3;
const SKILLS_BROKER_PORT = parseInt(
  process.env.SKILLS_BROKER_PORT ?? '8103',
  10,
);
const FETCH_TIMEOUT_MS = 5_000;
// Hard cap on broker response size (mirrors registry-client.ts). The signed
// prompt bundle is ~10 KB (5 packs); 256 KB is >10x headroom and bounds the
// heap exposure if a malicious or misbehaving host streams unbounded bytes
// before the 5 s timeout fires — at boot, before the signature check runs.
const MAX_BLOB_BYTES = 256 * 1024;

/**
 * Open a vsock connection to the host-side skills-broker, read the signed
 * skill-prompts bundle bytes, and return them as a UTF-8 string.
 *
 * Throws if the broker is unreachable, times out, or returns an empty payload.
 * Signature verification happens in the caller (loadSkillPrompts).
 */
export async function fetchSkillPromptsFromBroker(): Promise<string> {
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
      `skills-broker fetch requires @calypso/vsock-native ` +
        `(import failed: ${(err as Error).message})`,
    );
  }

  return new Promise<string>((resolve, reject) => {
    let socket: ReturnType<typeof vsock.connect>;
    try {
      socket = vsock.connect(SKILLS_BROKER_PORT, VSOCK_CID_PARENT);
    } catch (err) {
      reject(
        new Error(`skills-broker connection failed: ${(err as Error).message}`),
      );
      return;
    }

    const timeout = setTimeout(() => {
      socket.destroy(new Error('skills-broker timeout'));
      reject(
        new Error(
          `skills-broker on vsock:${VSOCK_CID_PARENT}:${SKILLS_BROKER_PORT} timed out`,
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
            `skills-broker oversized payload (received ${received} bytes, max ${MAX_BLOB_BYTES})`,
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
        return reject(new Error('skills-broker returned empty payload'));
      }
      resolve(raw);
    });
    socket.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`skills-broker connection failed: ${err.message}`));
    });
  });
}
