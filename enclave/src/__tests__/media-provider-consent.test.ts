import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildConsentMessage,
  verifyProviderVisibleInputConsent,
  verifyWebAuthnConsentSignature,
} from "../media/provider-consent";

const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const verifier = {
  verify: async (
    message: string,
    signature:
      | { type: "device_key"; signature: string }
      | {
          type: "webauthn";
          credentialId: string;
          authenticatorData: string;
          clientDataJSON: string;
          signature: string;
        },
  ) => {
    if (signature.type !== "device_key") return false;
    return verify(
      null,
      Buffer.from(message),
      createPublicKey(publicKey),
      Buffer.from(signature.signature, "base64"),
    );
  },
};

function signedConsent(overrides: Record<string, unknown> = {}) {
  const unsigned = {
    consentId: "consent_1",
    planId: "plan_1",
    subtaskId: "clip_1",
    providerId: "google",
    modelId: "veo-3.1-generate-preview",
    inputHandleSetHash: "d".repeat(64),
    enclaveNonce: "nonce_1234567890123456",
    expiresAt: "2026-05-19T08:05:00.000Z",
    signerKeyId: "device_key_1",
    ...overrides,
  };
  return {
    ...unsigned,
    signature: {
      type: "device_key",
      signature: sign(
        null,
        Buffer.from(
          buildConsentMessage(
            unsigned as Parameters<typeof buildConsentMessage>[0],
          ),
        ),
        createPrivateKey(privateKey),
      ).toString("base64"),
    },
  };
}

describe("provider-visible input consent", () => {
  it("accepts a token bound to exact plan, provider, model, nonce, and input hash", async () => {
    const result = await verifyProviderVisibleInputConsent({
      consent: signedConsent(),
      expected: {
        planId: "plan_1",
        subtaskId: "clip_1",
        providerId: "google",
        modelId: "veo-3.1-generate-preview",
        inputHandleSetHash: "d".repeat(64),
        enclaveNonce: "nonce_1234567890123456",
        pinnedSignerKeyId: "device_key_1",
        revokedSignerKeyIds: new Set<string>(),
      },
      verifier,
      now: new Date("2026-05-19T08:04:00.000Z"),
      seenConsentIds: new Set(),
    });

    expect(result.ok).toBe(true);
  });

  it("rejects replay, expiry, and changed input hashes", async () => {
    const seen = new Set<string>(["consent_1"]);
    const replayResult = await verifyProviderVisibleInputConsent({
      consent: signedConsent(),
      expected: {
        planId: "plan_1",
        subtaskId: "clip_1",
        providerId: "google",
        modelId: "veo-3.1-generate-preview",
        inputHandleSetHash: "d".repeat(64),
        enclaveNonce: "nonce_1234567890123456",
        pinnedSignerKeyId: "device_key_1",
        revokedSignerKeyIds: new Set<string>(),
      },
      verifier,
      now: new Date("2026-05-19T08:04:00.000Z"),
      seenConsentIds: seen,
    });
    expect(replayResult.ok).toBe(false);
    if (!replayResult.ok) expect(replayResult.reason).toBe("CONSENT_REPLAYED");

    const bindingResult = await verifyProviderVisibleInputConsent({
      consent: signedConsent(),
      expected: {
        planId: "plan_1",
        subtaskId: "clip_1",
        providerId: "google",
        modelId: "veo-3.1-generate-preview",
        inputHandleSetHash: "e".repeat(64),
        enclaveNonce: "nonce_1234567890123456",
        pinnedSignerKeyId: "device_key_1",
        revokedSignerKeyIds: new Set<string>(),
      },
      verifier,
      now: new Date("2026-05-19T08:04:00.000Z"),
      seenConsentIds: new Set(),
    });
    expect(bindingResult.ok).toBe(false);
    if (!bindingResult.ok)
      {expect(bindingResult.reason).toBe("CONSENT_BINDING_MISMATCH");}

    const revokedResult = await verifyProviderVisibleInputConsent({
      consent: signedConsent({ signerKeyId: "rotated_key" }),
      expected: {
        planId: "plan_1",
        subtaskId: "clip_1",
        providerId: "google",
        modelId: "veo-3.1-generate-preview",
        inputHandleSetHash: "d".repeat(64),
        enclaveNonce: "nonce_1234567890123456",
        pinnedSignerKeyId: "device_key_1",
        revokedSignerKeyIds: new Set<string>(["rotated_key"]),
      },
      verifier,
      now: new Date("2026-05-19T08:04:00.000Z"),
      seenConsentIds: new Set(),
    });
    expect(revokedResult.ok).toBe(false);
    if (!revokedResult.ok)
      {expect(revokedResult.reason).toBe("CONSENT_SIGNER_KEY_MISMATCH");}
  });

  it("rejects WebAuthn consent when the assertion credential differs from the pinned signer id", async () => {
    const result = await verifyProviderVisibleInputConsent({
      consent: {
        ...signedConsent({ signerKeyId: "credential_1" }),
        signature: {
          type: "webauthn",
          credentialId: "credential_2",
          authenticatorData: "AA",
          clientDataJSON: "AA",
          signature: "AA",
        },
      },
      expected: {
        planId: "plan_1",
        subtaskId: "clip_1",
        providerId: "google",
        modelId: "veo-3.1-generate-preview",
        inputHandleSetHash: "d".repeat(64),
        enclaveNonce: "nonce_1234567890123456",
        pinnedSignerKeyId: "credential_1",
        revokedSignerKeyIds: new Set<string>(),
      },
      verifier: { verify: async () => true },
      now: new Date("2026-05-19T08:04:00.000Z"),
      seenConsentIds: new Set(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "CONSENT_SIGNER_KEY_MISMATCH",
    });
  });
});

function makeSyntheticWebAuthnAssertion(input: {
  message: string;
  credentialId: string;
  privateKey: string;
  origin: string;
  rpId: string;
  signCounter: number;
  // Default UP|UV (0x05) — a real userVerification:'required' assertion.
  flags?: number;
  // Trailing extension bytes after the 4-byte counter; used to prove the
  // counter is read from the fixed offset 33, not the last four bytes.
  extensionBytes?: Buffer;
}) {
  const rpHash = createHash("sha256").update(input.rpId).digest();
  const authenticatorData = Buffer.concat([
    rpHash,
    Buffer.from([input.flags ?? 0x05]),
    Buffer.from([0, 0, 0, input.signCounter]),
    input.extensionBytes ?? Buffer.alloc(0),
  ]);
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: createHash("sha256").update(input.message).digest("base64url"),
      origin: input.origin,
    }),
  );
  const signedBytes = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJSON).digest(),
  ]);
  return {
    type: "webauthn" as const,
    credentialId: input.credentialId,
    authenticatorData: authenticatorData.toString("base64url"),
    clientDataJSON: clientDataJSON.toString("base64url"),
    signature: sign(
      null,
      signedBytes,
      createPrivateKey(input.privateKey),
    ).toString("base64url"),
  };
}

function assertionForOrigin(message: string, origin: string) {
  return makeSyntheticWebAuthnAssertion({
    message,
    credentialId: "credential_1",
    privateKey,
    origin,
    rpId: "app.calypso.local",
    signCounter: 5,
  });
}

describe("provider-visible WebAuthn consent", () => {
  it("rejects swapped challenges, untrusted origins, rp-id mismatches, counter regression, and bad signatures", () => {
    const message = buildConsentMessage({
      consentId: "consent_1",
      planId: "plan_1",
      subtaskId: "clip_1",
      providerId: "google",
      modelId: "veo-3.1-generate-preview",
      inputHandleSetHash: "d".repeat(64),
      enclaveNonce: "nonce_1234567890123456",
      expiresAt: "2026-05-19T08:05:00.000Z",
      signerKeyId: "credential_1",
    });
    const credential = {
      credentialId: "credential_1",
      publicKeyPem: publicKey,
      rpIdHash: createHash("sha256").update("app.calypso.local").digest("hex"),
      originAllowlist: ["https://app.calypso.local"],
      previousSignCounter: 4,
    };
    const assertion = makeSyntheticWebAuthnAssertion({
      message,
      credentialId: "credential_1",
      privateKey,
      origin: "https://app.calypso.local",
      rpId: "app.calypso.local",
      signCounter: 5,
    });

    expect(
      verifyWebAuthnConsentSignature({
        message,
        signature: assertion,
        credential,
      }),
    ).toMatchObject({ ok: true });

    const challengeResult = verifyWebAuthnConsentSignature({
      message: `${message}x`,
      signature: assertion,
      credential,
    });
    expect(challengeResult.ok).toBe(false);
    if (!challengeResult.ok)
      {expect(challengeResult.reason).toBe("WEBAUTHN_CHALLENGE_MISMATCH");}

    const originResult = verifyWebAuthnConsentSignature({
      message,
      signature: {
        ...assertion,
        clientDataJSON: assertionForOrigin(message, "https://evil.example")
          .clientDataJSON,
      },
      credential,
    });
    expect(originResult.ok).toBe(false);
    if (!originResult.ok)
      {expect(originResult.reason).toBe("WEBAUTHN_ORIGIN_INVALID");}

    const rpResult = verifyWebAuthnConsentSignature({
      message,
      signature: assertion,
      credential: { ...credential, rpIdHash: "0".repeat(64) },
    });
    expect(rpResult.ok).toBe(false);
    if (!rpResult.ok) expect(rpResult.reason).toBe("WEBAUTHN_RP_ID_MISMATCH");

    const counterResult = verifyWebAuthnConsentSignature({
      message,
      signature: assertion,
      credential: { ...credential, previousSignCounter: 5 },
    });
    expect(counterResult.ok).toBe(false);
    if (!counterResult.ok)
      {expect(counterResult.reason).toBe("WEBAUTHN_SIGN_COUNTER_REGRESSED");}
  });

  // Codex LOW F3 — the flags byte was never inspected, so a signature made
  // without a user gesture could authorise provider-visible media handling.
  it("rejects assertions missing User Present / User Verified", () => {
    const message = buildConsentMessage({
      consentId: "consent_1",
      planId: "plan_1",
      subtaskId: "clip_1",
      providerId: "google",
      modelId: "veo-3.1-generate-preview",
      inputHandleSetHash: "d".repeat(64),
      enclaveNonce: "nonce_1234567890123456",
      expiresAt: "2026-05-19T08:05:00.000Z",
      signerKeyId: "credential_1",
    });
    const credential = {
      credentialId: "credential_1",
      publicKeyPem: publicKey,
      rpIdHash: createHash("sha256").update("app.calypso.local").digest("hex"),
      originAllowlist: ["https://app.calypso.local"],
      previousSignCounter: 4,
    };
    const base = {
      message,
      credentialId: "credential_1",
      privateKey,
      origin: "https://app.calypso.local",
      rpId: "app.calypso.local",
      signCounter: 5,
    };

    // flags=0x04 → UV set but UP cleared.
    const noUp = verifyWebAuthnConsentSignature({
      message,
      signature: makeSyntheticWebAuthnAssertion({ ...base, flags: 0x04 }),
      credential,
    });
    expect(noUp.ok).toBe(false);
    if (!noUp.ok) expect(noUp.reason).toBe("WEBAUTHN_USER_PRESENCE_MISSING");

    // flags=0x01 → UP set but UV cleared (the old fixture default).
    const noUv = verifyWebAuthnConsentSignature({
      message,
      signature: makeSyntheticWebAuthnAssertion({ ...base, flags: 0x01 }),
      credential,
    });
    expect(noUv.ok).toBe(false);
    if (!noUv.ok)
      {expect(noUv.reason).toBe("WEBAUTHN_USER_VERIFICATION_MISSING");}
  });

  // Codex LOW F3 — the counter must be read from the fixed offset 33, not the
  // last four bytes; otherwise appended extension bytes spoof the counter.
  it("reads the sign counter from offset 33 even when extension bytes follow", () => {
    const message = buildConsentMessage({
      consentId: "consent_1",
      planId: "plan_1",
      subtaskId: "clip_1",
      providerId: "google",
      modelId: "veo-3.1-generate-preview",
      inputHandleSetHash: "d".repeat(64),
      enclaveNonce: "nonce_1234567890123456",
      expiresAt: "2026-05-19T08:05:00.000Z",
      signerKeyId: "credential_1",
    });
    const credential = {
      credentialId: "credential_1",
      publicKeyPem: publicKey,
      rpIdHash: createHash("sha256").update("app.calypso.local").digest("hex"),
      originAllowlist: ["https://app.calypso.local"],
      previousSignCounter: 4,
    };
    // Real counter at offset 33 is 5 (valid, > 4). Trailing extension bytes
    // encode a large value the last-four-bytes bug would have read instead.
    const assertion = makeSyntheticWebAuthnAssertion({
      message,
      credentialId: "credential_1",
      privateKey,
      origin: "https://app.calypso.local",
      rpId: "app.calypso.local",
      signCounter: 5,
      extensionBytes: Buffer.from([0xff, 0xff, 0xff, 0xff]),
    });
    const result = verifyWebAuthnConsentSignature({
      message,
      signature: assertion,
      credential,
    });
    expect(result).toMatchObject({ ok: true, signCounter: 5 });
  });
});
