import { describe, it, expect } from 'vitest';
import { webcrypto, X509Certificate, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { verifyNitroAttestation } from '../nitro-verify';
import { encodeCBOR, type CBORValue } from '../cbor';

describe('verifyNitroAttestation', () => {
  it('rejects empty input', async () => {
    await expect(verifyNitroAttestation('')).rejects.toThrow();
  });

  it('rejects non-COSE input', async () => {
    // base64 of "not-cose-data"
    const b64 = btoa('not-cose-data');
    await expect(verifyNitroAttestation(b64)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// M2 error-handling-audit regressions — structurally deficient payloads must
// throw typed errors, never produce a success-shaped result with lenient
// defaults (PCR0 = '' would sail through the dev-bypass path, which skips
// exactly the pin comparison that would catch it).
// ---------------------------------------------------------------------------

/** CBOR map header for < 24 entries, entries spliced as raw encoded bytes. */
function cborMapRaw(entries: Array<[CBORValue, Uint8Array]>): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xa0 | entries.length])];
  for (const [k, rawValue] of entries) {
    parts.push(encodeCBOR(k), rawValue);
  }
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function makeDocB64(payloadEntries: Array<[CBORValue, Uint8Array]>): string {
  const payload = cborMapRaw(payloadEntries);
  const cose = encodeCBOR([
    new Uint8Array([0xa0]), // protected header (empty map, bytes)
    null, // unprotected header
    payload,
    new Uint8Array(96).fill(3), // signature (never reached in these tests)
  ]);
  return Buffer.from(cose).toString('base64');
}

describe('structural payload validation (fail-closed, M2)', () => {
  const pcr = new Uint8Array(48).fill(7);
  const fullPcrs: Array<[CBORValue, Uint8Array]> = [
    [0, encodeCBOR(pcr)],
    [1, encodeCBOR(pcr)],
    [2, encodeCBOR(pcr)],
  ];
  const baseEntries = (
    pcrs: Array<[CBORValue, Uint8Array]>,
    withNonce: boolean,
  ): Array<[CBORValue, Uint8Array]> => {
    const entries: Array<[CBORValue, Uint8Array]> = [
      ['certificate', encodeCBOR(new Uint8Array([0x30, 0x00]))],
      ['cabundle', encodeCBOR([])],
      ['pcrs', cborMapRaw(pcrs)],
    ];
    if (withNonce) entries.push(['nonce', encodeCBOR(new Uint8Array(32).fill(9))]);
    return entries;
  };

  it('throws a typed error when pcrs[0] is missing', async () => {
    const doc = makeDocB64(
      baseEntries(
        [
          [1, encodeCBOR(pcr)],
          [2, encodeCBOR(pcr)],
        ],
        true,
      ),
    );
    await expect(verifyNitroAttestation(doc)).rejects.toThrow(
      /Attestation payload missing PCR0/,
    );
  });

  it('throws a typed error when a PCR is present but not a byte string', async () => {
    const doc = makeDocB64(
      baseEntries(
        [
          [0, encodeCBOR('not-bytes')],
          [1, encodeCBOR(pcr)],
          [2, encodeCBOR(pcr)],
        ],
        true,
      ),
    );
    await expect(verifyNitroAttestation(doc)).rejects.toThrow(
      /Attestation payload missing PCR0/,
    );
  });

  it('throws a typed error when the nonce is missing', async () => {
    const doc = makeDocB64(baseEntries(fullPcrs, false));
    await expect(verifyNitroAttestation(doc)).rejects.toThrow(
      /Attestation payload missing nonce/,
    );
  });

  it('throws a typed error when the nonce is an empty byte string', async () => {
    const entries = baseEntries(fullPcrs, false);
    entries.push(['nonce', encodeCBOR(new Uint8Array(0))]);
    const doc = makeDocB64(entries);
    await expect(verifyNitroAttestation(doc)).rejects.toThrow(
      /Attestation payload missing nonce/,
    );
  });
});

/**
 * The pinned AWS Nitro root CA DER is the trust anchor for every attestation
 * verify. If its bytes drift (a stray typo when re-pasting the base64), cert
 * chain verification breaks with a misleading WebCrypto decode error at
 * runtime. This test pins the subject + importKey success so a single-char
 * bit-rot fails the unit suite instead of breaking live attestation.
 */
describe('AWS_NITRO_ROOT_CA_DER (pinned trust anchor)', () => {
  // Re-parse the exact bytes from the source file so we validate what
  // production ships, not what we typed into this test.
  async function loadPinnedCert(): Promise<{ cert: X509Certificate; der: Buffer }> {
    const { default: srcText } = await import('node:fs').then((fs) => ({
      default: fs.readFileSync(new URL('../nitro-verify.ts', import.meta.url), 'utf-8'),
    }));
    const match = srcText.match(/AWS_NITRO_ROOT_CA_DER = \(\(\) => \{\s*[^]*?const b64 =\s*([^]*?);[\s]*return fromBase64\(b64\);/);
    expect(match).toBeTruthy();
    const b64 = match![1].replace(/\s*\+?\s*'([^']+)'/g, '$1');
    const pem = `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
    return { cert: new X509Certificate(pem), der: Buffer.from(b64, 'base64') };
  }

  it('parses as a valid X.509 cert signed by AWS Nitro', async () => {
    const { cert } = await loadPinnedCert();
    expect(cert.subject).toContain('CN=aws.nitro-enclaves');
    expect(cert.subject).toContain('O=Amazon');

    // Sanity: the pinned SPKI must be importable as ECDSA P-384 (the curve
    // AWS uses). This is the exact operation that breaks in live code when
    // the DER is corrupted.
    const spki = cert.publicKey.export({ format: 'der', type: 'spki' });
    const key = await webcrypto.subtle.importKey(
      'spki',
      spki,
      { name: 'ECDSA', namedCurve: 'P-384' },
      false,
      ['verify'],
    );
    expect(key.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-384' });
  });

  // --- Bug 3 extended regressions (Workstream A) -------------------------

  it('matches the pinned SHA-384 fingerprint (any bit-rot trips this)', async () => {
    const { der } = await loadPinnedCert();
    const actual = createHash('sha384').update(der).digest('hex');
    // Captured on 2026-04-18 from the canonical AWS_NitroEnclaves_Root-G1.
    // If AWS ever rotates the root (unlikely pre-2049), update this pin.
    const expected =
      '0a2a94444eaed2a0a584ec419284e645777bc81864268d33104d1c9796e824fbdc49a7b4d94ddc0b5a98ccb9e0cde50d';
    expect(actual).toBe(expected);
  });

  it('expiry (validTo) is still in the future', async () => {
    const { cert } = await loadPinnedCert();
    const notAfter = new Date(cert.validTo);
    expect(notAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it('is self-signed: subject === issuer (AWS Nitro root CA)', async () => {
    const { cert } = await loadPinnedCert();
    // Normalise whitespace/line breaks — Node exposes subject/issuer as
    // newline-separated DNs; we just compare the RDN set.
    const norm = (dn: string) => dn.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort().join(',');
    expect(norm(cert.subject)).toBe(norm(cert.issuer));

    const rdns = norm(cert.subject);
    expect(rdns).toContain('CN=aws.nitro-enclaves');
    expect(rdns).toContain('O=Amazon');
    expect(rdns).toContain('OU=AWS');
    expect(rdns).toContain('C=US');
  });
});
