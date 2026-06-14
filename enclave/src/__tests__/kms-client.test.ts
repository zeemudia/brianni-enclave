import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../keys-client.js', () => ({
  fetchKeysBlobFromBroker: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: () => true };
});

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

// fetchKeysViaAttestedKMS calls fetchCredsFromBroker() before the kmstool
// decrypt loop. That function uses vsock.connect() to read IAM creds.
// We stub vsock-native with a fake connect() that returns a FakeSocket
// emitting a canned cred-broker payload. Without this, cred-broker fetch
// would hang indefinitely and the "green" step would never resolve.
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy(err?: Error) {
    this.destroyed = true;
    if (err) this.emit('error', err);
  }
}

const OK_CREDS_JSON =
  '{"AccessKeyId":"A","SecretAccessKey":"S","Token":"T","Expiration":"2099-01-01T00:00:00Z"}';

vi.mock('@calypso/vsock-native', () => ({
  connect: vi.fn(() => {
    const sock = new FakeSocket();
    setImmediate(() => {
      sock.emit('data', Buffer.from(OK_CREDS_JSON));
      sock.emit('end');
    });
    return sock;
  }),
}));

import { fetchKeysViaAttestedKMS } from '../kms-client.js';
import { fetchKeysBlobFromBroker } from '../keys-client.js';
import { spawnSync } from 'node:child_process';

function mockKmstool(plaintext: string) {
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    stdout: `PLAINTEXT: ${Buffer.from(plaintext).toString('base64')}\n`,
    stderr: '',
    pid: 1, signal: null, output: [], error: undefined,
  } as any);
}

describe('fetchKeysViaAttestedKMS — provider-set cross-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOCK_KMS = 'true';
  });
  afterEach(() => {
    delete process.env.MOCK_KMS;
  });

  it('succeeds when blob providers ⊆ registry providers', async () => {
    vi.mocked(fetchKeysBlobFromBroker).mockResolvedValueOnce({
      kmsKeyArn: 'arn:abc',
      providers: { openai: 'c1', anthropic: 'c2' },
    });
    mockKmstool('sk-fake');
    const registryProviderIds = new Set(['openai', 'anthropic', 'google']);
    const { providerKeys: keys } = await fetchKeysViaAttestedKMS(registryProviderIds);
    expect(Object.keys(keys).sort()).toEqual(['anthropic', 'openai']);
  });

  it('throws PROVIDER_SET_MISMATCH when blob has provider registry does not', async () => {
    vi.mocked(fetchKeysBlobFromBroker).mockResolvedValueOnce({
      kmsKeyArn: 'arn:abc',
      providers: { openai: 'c1', xai: 'c3' },
    });
    mockKmstool('sk-fake');
    const registryProviderIds = new Set(['openai', 'anthropic']);
    await expect(
      fetchKeysViaAttestedKMS(registryProviderIds),
    ).rejects.toThrow(/PROVIDER_SET_MISMATCH/);
  });

  it('allows registry ⊃ blob (in-progress rollout)', async () => {
    vi.mocked(fetchKeysBlobFromBroker).mockResolvedValueOnce({
      kmsKeyArn: 'arn:abc',
      providers: { openai: 'c1' },
    });
    mockKmstool('sk-fake');
    const registryProviderIds = new Set(['openai', 'anthropic', 'mistral']);
    const { providerKeys: keys } = await fetchKeysViaAttestedKMS(registryProviderIds);
    expect(Object.keys(keys)).toEqual(['openai']);
  });
});

describe('fetchKeysViaAttestedKMS — media-root secret delivery (#1 provenance rooting)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOCK_KMS = 'true';
  });
  afterEach(() => {
    delete process.env.MOCK_KMS;
  });

  it('decrypts and returns the mediaRootSecret when the blob carries one', async () => {
    vi.mocked(fetchKeysBlobFromBroker).mockResolvedValueOnce({
      kmsKeyArn: 'arn:abc',
      providers: { openai: 'c1' },
      mediaRootSecret: 'cipher-media-root',
    });
    // Every ciphertext decrypts to this fixed plaintext via the mock.
    mockKmstool('media-root-secret-base64==');
    const result = await fetchKeysViaAttestedKMS(new Set(['openai']));
    expect(result.providerKeys).toEqual({ openai: 'media-root-secret-base64==' });
    expect(result.mediaRootSecret).toBe('media-root-secret-base64==');
  });

  it('returns mediaRootSecret = null when the blob omits it (back-compat / pre-rotation)', async () => {
    vi.mocked(fetchKeysBlobFromBroker).mockResolvedValueOnce({
      kmsKeyArn: 'arn:abc',
      providers: { openai: 'c1' },
    });
    mockKmstool('sk-fake');
    const result = await fetchKeysViaAttestedKMS(new Set(['openai']));
    expect(result.mediaRootSecret).toBeNull();
    expect(result.providerKeys).toEqual({ openai: 'sk-fake' });
  });
});

describe('fetchKeysViaAttestedKMS — kmstool failure-path redaction (M5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOCK_KMS = 'true';
  });
  afterEach(() => {
    delete process.env.MOCK_KMS;
  });

  it('never echoes kmstool stdout (potential key material) into the thrown error', async () => {
    vi.mocked(fetchKeysBlobFromBroker).mockResolvedValueOnce({
      kmsKeyArn: 'arn:abc',
      providers: { openai: 'c1' },
    });
    // kmstool exits 0 but the PLAINTEXT marker is missing — by design the
    // stdout still carries decrypted key material in adjacent failure
    // modes, so it must NEVER be interpolated into the error message
    // (boot errors hit console.error → host-visible stderr).
    const SECRET = 'sk-SUPER_SECRET_KEY_MATERIAL';
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: `${SECRET}\n`,
      stderr: '',
      pid: 1, signal: null, output: [], error: undefined,
    } as any);

    let thrown: Error | undefined;
    try {
      await fetchKeysViaAttestedKMS(new Set(['openai']));
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/PLAINTEXT/);
    expect(thrown!.message).not.toContain(SECRET);
  });
});

describe('fetchKeysViaAttestedKMS — EXPECTED_KMS_KEY_ARN pin', () => {
  const EXPECTED = 'arn:aws:kms:eu-west-2:123456789012:key/aaa30049-eb10-458c-9a0c-3c0183ac0593';

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOCK_KMS = 'true';
  });
  afterEach(() => {
    delete process.env.MOCK_KMS;
    delete process.env.EXPECTED_KMS_KEY_ARN;
    // Re-import cycle is cached so the module-level const reads the env
    // value once at module-load time. We reset the module registry so
    // each test observes the env-var state it sets. See note below.
    vi.resetModules();
  });

  // kms-client captures EXPECTED_KMS_KEY_ARN into a module-level const at
  // load time. To exercise both "set" and "unset" states we reload the
  // module via dynamic import after mutating process.env. The top-level
  // vi.mock() calls still apply to reloaded modules.
  async function loadFreshKmsClient() {
    vi.resetModules();
    return (await import('../kms-client.js')) as typeof import('../kms-client.js');
  }

  it('accepts blob when kmsKeyArn matches EXPECTED_KMS_KEY_ARN', async () => {
    process.env.EXPECTED_KMS_KEY_ARN = EXPECTED;
    const { fetchKeysViaAttestedKMS: fresh } = await loadFreshKmsClient();
    // Re-mock fetchKeysBlobFromBroker after module reset.
    const { fetchKeysBlobFromBroker: freshFetch } = await import('../keys-client.js');
    vi.mocked(freshFetch).mockResolvedValueOnce({
      kmsKeyArn: EXPECTED,
      providers: { openai: 'c1' },
    });
    mockKmstool('sk-fake');
    const { providerKeys: keys } = await fresh(new Set(['openai']));
    expect(Object.keys(keys)).toEqual(['openai']);
  });

  it('throws KMS_KEY_ARN_MISMATCH when blob kmsKeyArn differs from expected', async () => {
    process.env.EXPECTED_KMS_KEY_ARN = EXPECTED;
    const { fetchKeysViaAttestedKMS: fresh } = await loadFreshKmsClient();
    const { fetchKeysBlobFromBroker: freshFetch } = await import('../keys-client.js');
    vi.mocked(freshFetch).mockResolvedValueOnce({
      kmsKeyArn: 'arn:aws:kms:eu-west-2:123456789012:key/00000000-0000-0000-0000-000000000000',
      providers: { openai: 'c1' },
    });
    mockKmstool('sk-fake');
    await expect(fresh(new Set(['openai']))).rejects.toThrow(/KMS_KEY_ARN_MISMATCH/);
  });

  it('no enforcement when EXPECTED_KMS_KEY_ARN is unset (happy path unchanged)', async () => {
    delete process.env.EXPECTED_KMS_KEY_ARN;
    const { fetchKeysViaAttestedKMS: fresh } = await loadFreshKmsClient();
    const { fetchKeysBlobFromBroker: freshFetch } = await import('../keys-client.js');
    vi.mocked(freshFetch).mockResolvedValueOnce({
      kmsKeyArn: 'arn:anything',
      providers: { openai: 'c1' },
    });
    mockKmstool('sk-fake');
    const { providerKeys: keys } = await fresh(new Set(['openai']));
    expect(Object.keys(keys)).toEqual(['openai']);
  });
});
