/**
 * Fetches the KMS-encrypted provider-key blob from the host-side
 * keys-broker (infra/host/keys-broker.py) over AF_VSOCK:8102.
 *
 * Why this file exists: provider-key rotation must not require a
 * client release. Baking the blob into the EIF made PCR0 change
 * on every rotation, forcing a mobile+web pin update. Host-serving
 * the blob decouples the two lifecycles — the blob changes on the
 * host, the EIF does not.
 *
 * Trust: the KMS policy binds decryption to the pinned PCR0, so a
 * host substituting a ciphertext produces plaintexts the attacker
 * does not control. No signature verification at this boundary.
 *
 * Provider-set cross-check against the registry is performed in
 * kms-client.ts after the decrypt loop completes, not here.
 */
import { Buffer } from 'node:buffer';

const VSOCK_CID_PARENT = 3;
const KEYS_BROKER_PORT = parseInt(
  process.env.KEYS_BROKER_PORT ?? '8102',
  10,
);
const FETCH_TIMEOUT_MS = 5_000;
// Hard cap on broker response size. Expected blob is <10 KB (3 providers
// of ~500-byte base64 ciphertext + kmsKeyArn field). 64 KB is 6× headroom
// for schema growth (more providers, longer ARNs) and bounds the heap
// exposure if a malicious or misbehaving host streams unbounded bytes
// before the 5 s timeout fires. Without this cap, the 'data' handler
// would accumulate chunks into memory until OOM.
const MAX_BLOB_BYTES = 64 * 1024;

export const KEYS_BROKER_UNREACHABLE = 'KEYS_BROKER_UNREACHABLE';
export const KEYS_BROKER_MALFORMED = 'KEYS_BROKER_MALFORMED';

export interface EncryptedKeysBlob {
  kmsKeyArn: string;
  providers: Record<string, string>;
  /**
   * Optional KMS ciphertext of the media-root secret (base64). Wrapped under
   * the same PCR0-gated KMS key as the provider keys; decrypted in kms-client
   * and HKDF-derived into the stable media-provenance signing key. Absent on
   * blobs provisioned before attestation-rooted provenance landed (the enclave
   * then falls back to an ephemeral per-boot provenance key).
   */
  mediaRootSecret?: string;
}

/**
 * Open a vsock connection to the host-side keys-broker, read the
 * JSON bytes, parse, validate shape, and return the blob.
 *
 * Throws:
 *   - KEYS_BROKER_UNREACHABLE — vsock connect/read errored before payload arrived
 *   - KEYS_BROKER_MALFORMED   — bytes arrived but did not parse as valid blob
 *   - generic Error with 'empty' / 'timed out' / 'at least one provider' for
 *     the corresponding specific cases (caller does not distinguish these from
 *     UNREACHABLE for observability)
 */
export async function fetchKeysBlobFromBroker(): Promise<EncryptedKeysBlob> {
  let vsock: typeof import('@calypso/vsock-native');
  try {
    vsock = (await import(
      '@calypso/vsock-native' as string
    )) as typeof import('@calypso/vsock-native');
  } catch (err) {
    throw new Error(
      `${KEYS_BROKER_UNREACHABLE}: @calypso/vsock-native import failed: ${(err as Error).message}`,
    );
  }

  const raw = await new Promise<string>((resolve, reject) => {
    let socket: ReturnType<typeof vsock.connect>;
    try {
      socket = vsock.connect(KEYS_BROKER_PORT, VSOCK_CID_PARENT);
    } catch (err) {
      reject(
        new Error(
          `${KEYS_BROKER_UNREACHABLE}: ${(err as Error).message}`,
        ),
      );
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
          `${KEYS_BROKER_UNREACHABLE}: keys-broker on vsock:${VSOCK_CID_PARENT}:${KEYS_BROKER_PORT} timed out`,
        ),
      );
    }, FETCH_TIMEOUT_MS);

    socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BLOB_BYTES) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        return reject(
          new Error(
            `${KEYS_BROKER_MALFORMED}: oversized payload (received ${received} bytes, max ${MAX_BLOB_BYTES})`,
          ),
        );
      }
      chunks.push(chunk);
    });
    socket.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const text = Buffer.concat(chunks).toString('utf-8');
      if (text.length === 0) {
        return reject(new Error(`${KEYS_BROKER_UNREACHABLE}: empty payload`));
      }
      resolve(text);
    });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`${KEYS_BROKER_UNREACHABLE}: closed before response`));
    });
    socket.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`${KEYS_BROKER_UNREACHABLE}: ${err.message}`));
    });
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${KEYS_BROKER_MALFORMED}: not valid JSON`);
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as any).kmsKeyArn !== 'string' ||
    typeof (parsed as any).providers !== 'object' ||
    (parsed as any).providers === null
  ) {
    throw new Error(`${KEYS_BROKER_MALFORMED}: missing kmsKeyArn or providers`);
  }

  const providers = (parsed as any).providers as Record<string, unknown>;
  const providerIds = Object.keys(providers);
  if (providerIds.length === 0) {
    throw new Error('keys-broker blob must contain at least one provider');
  }
  for (const [id, value] of Object.entries(providers)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `${KEYS_BROKER_MALFORMED}: provider "${id}" value is not a non-empty string`,
      );
    }
  }

  // Optional media-root secret ciphertext. When present it MUST be a non-empty
  // string (a malformed value would silently disable provenance rooting).
  const mediaRootSecret = (parsed as any).mediaRootSecret;
  if (
    mediaRootSecret !== undefined &&
    (typeof mediaRootSecret !== 'string' || mediaRootSecret.length === 0)
  ) {
    throw new Error(
      `${KEYS_BROKER_MALFORMED}: mediaRootSecret present but not a non-empty string`,
    );
  }

  return parsed as EncryptedKeysBlob;
}
