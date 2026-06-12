/**
 * Attested KMS secret delivery for AWS Nitro Enclaves.
 *
 * At enclave boot:
 *   1. Fetch the encrypted-keys blob from the host-side keys-broker (vsock:8102)
 *      via keys-client.ts. No blob is baked into the EIF — the host serves it
 *      at runtime so provider-key rotation does not require an EIF rebuild.
 *   2. Fetch short-lived IAM creds from the host's cred-broker over vsock:8100.
 *   3. For each provider ciphertext in the blob, spawn `kmstool_enclave_cli decrypt`
 *      with those creds. kmstool speaks TLS + SigV4 to KMS through the host-side
 *      vsock-proxy on port 8000 and attaches the NSM attestation document itself,
 *      so KMS enforces the attestation-bound key policy.
 *   4. kmstool prints `PLAINTEXT: <base64>` on success; decode and return
 *      the map of provider → plaintext API key.
 *
 * Cross-check: after decryption, blob provider IDs are verified against the
 * registry's known provider IDs. Extra entries in the blob throw
 * PROVIDER_SET_MISMATCH. Registry ⊃ blob is allowed (in-progress rollout).
 */
import { existsSync } from 'node:fs';
import { fetchKeysBlobFromBroker } from './keys-client.js';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';

const NSM_DEVICE = '/dev/nsm';
const VSOCK_CID_PARENT = 3;
const KMS_PROXY_PORT = parseInt(process.env.KMS_PROXY_PORT ?? '8000', 10);
const CRED_BROKER_PORT = parseInt(process.env.CRED_BROKER_PORT ?? '8100', 10);
const KMSTOOL_BINARY = process.env.KMSTOOL_BINARY ?? '/usr/local/bin/kmstool_enclave_cli';
const KMS_REGION = process.env.AWS_REGION ?? 'eu-west-2';
const CRED_FETCH_TIMEOUT_MS = 5_000;
const KMSTOOL_TIMEOUT_MS = 15_000;

// Defence-in-depth against multi-key misprovisioning. kmstool decrypts based
// on ciphertext metadata, so if the AWS account ever has a second KMS key
// whose policy also attests the current PCR0 (test key left live, staging
// key, etc.), the enclave would silently accept ciphertexts wrapped under
// it. Pinning the expected ARN at boot closes that gap.
//
// In production, this value is baked into the EIF via `ENV` in
// `infra/docker/Dockerfile.enclave` and measured into PCR0 — nitro-cli
// run-enclave does not support runtime env injection, so a server/.env
// setting on the host would have no effect inside the enclave (that was
// the Codex round-2 HIGH #2 finding). Unit tests still exercise the
// guard by setting the env var before importing the module.
//
// Opt-in-when-present: unset means no enforcement, which preserves the
// local-dev / MOCK_KMS / unit-test paths where the Dockerfile is not in
// the picture.
const EXPECTED_KMS_KEY_ARN = process.env.EXPECTED_KMS_KEY_ARN ?? '';

interface IamCredentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  Token: string;
  Expiration: string;
}

/**
 * Fetch provider API keys from KMS using attested delivery via kmstool_enclave_cli.
 *
 * @param registryProviderIds Set of provider IDs known to the registry.
 *   Used for the post-decrypt cross-check: the blob must not carry
 *   provider IDs the registry does not know about. Pass an empty Set
 *   only in tests that intentionally bypass the cross-check.
 * @returns Map of provider ID to decrypted API key (subset of registry)
 */
export async function fetchKeysViaAttestedKMS(
  registryProviderIds: Set<string>,
): Promise<Record<string, string>> {
  if (!existsSync(NSM_DEVICE)) {
    throw new Error(
      'KMS attested delivery requires /dev/nsm (Nitro Enclave). ' +
      'Use MOCK_KMS=true or NODE_ENV=test for local development.',
    );
  }

  if (!existsSync(KMSTOOL_BINARY)) {
    throw new Error(
      `kmstool_enclave_cli not found at ${KMSTOOL_BINARY}. ` +
      'Bake it into the enclave image from aws-nitro-enclaves-sdk-c.',
    );
  }

  const blob = await fetchKeysBlobFromBroker();

  // Defence-in-depth: refuse blobs wrapped under an unexpected KMS key.
  // kmstool decrypts based on ciphertext metadata, so without this check
  // a second key whose policy attests the current PCR0 could silently
  // satisfy decrypt. See EXPECTED_KMS_KEY_ARN comment above.
  if (EXPECTED_KMS_KEY_ARN && blob.kmsKeyArn !== EXPECTED_KMS_KEY_ARN) {
    throw new Error(
      `KMS_KEY_ARN_MISMATCH: encrypted-keys blob wraps ciphertexts under ` +
      `${blob.kmsKeyArn} but enclave expects ${EXPECTED_KMS_KEY_ARN}. ` +
      `Rotate the blob via rotate-provider-keys.sh against the expected key ` +
      `or update EXPECTED_KMS_KEY_ARN (requires coordinated KMS policy + pin rotation).`,
    );
  }

  // Cross-check: blob provider IDs must be a subset of the registry's
  // provider IDs. Extra entries in the blob imply a deploy-time
  // inconsistency (registry out of sync with the key blob) that must
  // be resolved on the host, not silently papered over at runtime.
  const blobProviderIds = Object.keys(blob.providers);
  const unknown = blobProviderIds.filter(
    (id) => !registryProviderIds.has(id),
  );
  if (unknown.length > 0) {
    throw new Error(
      `PROVIDER_SET_MISMATCH: encrypted-keys blob contains providers the registry does not know: ` +
      `[${unknown.join(', ')}]. Blob has: [${blobProviderIds.join(', ')}]. ` +
      `Registry has: [${Array.from(registryProviderIds).sort().join(', ')}]. ` +
      `Resolve by regenerating encrypted-keys.json (rotate-provider-keys.sh) or by ` +
      `updating providers.json (registry-broker) so the two sets agree.`,
    );
  }

  const creds = await fetchCredsFromBroker();

  const decryptedKeys: Record<string, string> = {};
  for (const [providerId, ciphertext] of Object.entries(blob.providers)) {
    decryptedKeys[providerId] = decryptWithKmstool(ciphertext, creds);
  }

  console.log(
    `[enclave] KMS attested delivery: ${Object.keys(decryptedKeys).length} provider keys loaded`,
  );

  return decryptedKeys;
}

/**
 * Fetch short-lived IAM credentials from the host-side cred-broker
 * (python3 infra/host/cred-broker.py) listening on vsock:CRED_BROKER_PORT.
 *
 * The broker reads IMDSv2 creds for the EC2 instance's attached IAM role and
 * writes them as one line of JSON. We parse and return the subset kmstool needs.
 */
async function fetchCredsFromBroker(): Promise<IamCredentials> {
  // Lazy-import vsock-native: bundle shape differs between the enclave
  // (native addon) and local dev (missing), and we want a clear error at
  // runtime rather than a load-time failure.
  let vsock: typeof import('@calypso/vsock-native');
  try {
    vsock = (await import('@calypso/vsock-native' as string)) as typeof import('@calypso/vsock-native');
  } catch (err) {
    throw new Error(
      `KMS attested delivery requires @calypso/vsock-native (import failed: ${(err as Error).message})`,
    );
  }

  return new Promise<IamCredentials>((resolve, reject) => {
    let socket: ReturnType<typeof vsock.connect>;
    try {
      socket = vsock.connect(CRED_BROKER_PORT, VSOCK_CID_PARENT);
    } catch (err) {
      reject(new Error(`cred-broker connection failed: ${(err as Error).message}`));
      return;
    }

    const timeout = setTimeout(() => {
      socket.destroy(new Error('cred-broker timeout'));
      reject(new Error(`cred-broker on vsock:${VSOCK_CID_PARENT}:${CRED_BROKER_PORT} timed out`));
    }, CRED_FETCH_TIMEOUT_MS);

    const chunks: Buffer[] = [];

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on('end', () => {
      clearTimeout(timeout);
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        const parsed = JSON.parse(raw);
        if (parsed.error) {
          return reject(new Error(`cred-broker error: ${parsed.error}`));
        }
        if (!parsed.AccessKeyId || !parsed.SecretAccessKey || !parsed.Token) {
          return reject(new Error('cred-broker returned incomplete creds'));
        }
        resolve({
          AccessKeyId: parsed.AccessKeyId,
          SecretAccessKey: parsed.SecretAccessKey,
          Token: parsed.Token,
          Expiration: parsed.Expiration ?? 'unknown',
        });
      } catch (err) {
        reject(new Error(`Failed to parse cred-broker response: ${(err as Error).message}`));
      }
    });
    socket.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`cred-broker connection failed: ${err.message}`));
    });
  });
}

/**
 * Invoke kmstool_enclave_cli to decrypt one base64 KMS ciphertext and return
 * the UTF-8 plaintext. kmstool handles the attestation doc injection + TLS +
 * SigV4; KMS enforces the attestation-bound key policy.
 *
 * We pass creds + ciphertext via argv. argv is visible to root on the same
 * host but the enclave has no other root, and creds are short-lived (≤1h by
 * default on IMDSv2). Memory is zeroed on enclave shutdown per the Nitro
 * invariants we rely on elsewhere.
 */
function decryptWithKmstool(
  ciphertextBase64: string,
  creds: IamCredentials,
): string {
  const result = spawnSync(
    KMSTOOL_BINARY,
    [
      'decrypt',
      '--region', KMS_REGION,
      '--proxy-port', String(KMS_PROXY_PORT),
      '--aws-access-key-id', creds.AccessKeyId,
      '--aws-secret-access-key', creds.SecretAccessKey,
      '--aws-session-token', creds.Token,
      '--ciphertext', ciphertextBase64,
    ],
    {
      encoding: 'utf-8',
      timeout: KMSTOOL_TIMEOUT_MS,
      env: {
        ...process.env,
        // kmstool respects LD_LIBRARY_PATH to find libnsm.so.
        LD_LIBRARY_PATH: `${process.env.LD_LIBRARY_PATH ?? ''}:/usr/local/lib`,
      },
    },
  );

  if (result.error) {
    throw new Error(`kmstool spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `kmstool exited ${result.status}: ${result.stderr?.trim() || '<no stderr>'}`,
    );
  }

  // kmstool prints `PLAINTEXT: <base64>` on the last line of stdout.
  const match = (result.stdout ?? '').match(/PLAINTEXT:\s*([A-Za-z0-9+/=]+)/);
  if (!match) {
    // M5: NEVER interpolate stdout here — by design it carries decrypted
    // key material, and this error reaches console.error at boot, which
    // is host-visible stderr. Report only the exit status and length.
    throw new Error(
      `kmstool output did not contain PLAINTEXT marker (exit ${result.status}, stdout ${result.stdout?.length ?? 0} bytes)`,
    );
  }
  return Buffer.from(match[1], 'base64').toString('utf-8');
}
