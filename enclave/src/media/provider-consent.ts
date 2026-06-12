import { createHash, createPublicKey, verify } from "node:crypto";
import {
  canonicaliseProviderVisibleConsentUnsigned,
  ProviderVisibleInputConsentSchema,
  type ProviderVisibleInputConsent,
} from "@calypso/chat-types";

export interface ConsentVerifier {
  verify(
    message: string,
    signature: ProviderVisibleInputConsent["signature"],
  ): Promise<boolean>;
}

export interface PinnedWebAuthnCredential {
  credentialId: string;
  publicKeyPem: string;
  rpIdHash: string;
  originAllowlist: readonly string[];
  previousSignCounter: number;
}

export function verifyWebAuthnConsentSignature(input: {
  message: string;
  signature: Extract<
    ProviderVisibleInputConsent["signature"],
    { type: "webauthn" }
  >;
  credential: PinnedWebAuthnCredential;
}): { ok: true; signCounter: number } | { ok: false; reason: string } {
  if (input.signature.credentialId !== input.credential.credentialId) {
    return { ok: false, reason: "WEBAUTHN_CREDENTIAL_MISMATCH" };
  }
  let clientDataBytes: Buffer;
  let clientData: { type?: string; challenge?: string; origin?: string };
  try {
    clientDataBytes = Buffer.from(input.signature.clientDataJSON, "base64url");
    clientData = JSON.parse(clientDataBytes.toString("utf8")) as {
      type?: string;
      challenge?: string;
      origin?: string;
    };
  } catch {
    return { ok: false, reason: "WEBAUTHN_CLIENT_DATA_INVALID" };
  }
  if (clientData.type !== "webauthn.get")
    {return { ok: false, reason: "WEBAUTHN_TYPE_INVALID" };}
  if (
    !clientData.origin ||
    !input.credential.originAllowlist.includes(clientData.origin)
  ) {
    return { ok: false, reason: "WEBAUTHN_ORIGIN_INVALID" };
  }
  const expectedChallenge = createHash("sha256")
    .update(input.message)
    .digest("base64url");
  if (clientData.challenge !== expectedChallenge) {
    return { ok: false, reason: "WEBAUTHN_CHALLENGE_MISMATCH" };
  }
  let authenticatorData: Buffer;
  try {
    authenticatorData = Buffer.from(
      input.signature.authenticatorData,
      "base64url",
    );
  } catch {
    return { ok: false, reason: "WEBAUTHN_AUTHENTICATOR_DATA_INVALID" };
  }
  if (authenticatorData.byteLength < 37) {
    return { ok: false, reason: "WEBAUTHN_AUTHENTICATOR_DATA_INVALID" };
  }
  if (
    authenticatorData.subarray(0, 32).toString("hex") !==
    input.credential.rpIdHash
  ) {
    return { ok: false, reason: "WEBAUTHN_RP_ID_MISMATCH" };
  }
  // Codex LOW F3 — the flags byte (offset 32) was never inspected, so a valid
  // signature produced WITHOUT a user gesture (UP=0) could authorise
  // provider-visible handling of private media. This is a privacy-sensitive
  // consent gate, so require both User Present (0x01) and User Verified (0x04)
  // — matching the project-wide userVerification: 'required' contract.
  const flags = authenticatorData[32];
  const USER_PRESENT = 0x01;
  const USER_VERIFIED = 0x04;
  if ((flags & USER_PRESENT) === 0) {
    return { ok: false, reason: "WEBAUTHN_USER_PRESENCE_MISSING" };
  }
  if ((flags & USER_VERIFIED) === 0) {
    return { ok: false, reason: "WEBAUTHN_USER_VERIFICATION_MISSING" };
  }
  // Codex LOW F3 — the signature counter is at the fixed WebAuthn offset 33
  // (bytes 33..36, immediately after the flags byte), NOT the last four bytes.
  // Reading byteLength-4 returns extension-data bytes when extensions are
  // present, which lets attacker-controlled trailing bytes bypass the
  // counter-regression check or poison the persisted counter.
  const signCounter = authenticatorData.readUInt32BE(33);
  if (signCounter <= input.credential.previousSignCounter) {
    return { ok: false, reason: "WEBAUTHN_SIGN_COUNTER_REGRESSED" };
  }
  const signedBytes = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataBytes).digest(),
  ]);
  let ok = false;
  try {
    ok = verify(
      null,
      signedBytes,
      createPublicKey(input.credential.publicKeyPem),
      Buffer.from(input.signature.signature, "base64url"),
    );
  } catch {
    return { ok: false, reason: "WEBAUTHN_SIGNATURE_INVALID" };
  }
  return ok
    ? { ok: true, signCounter }
    : { ok: false, reason: "WEBAUTHN_SIGNATURE_INVALID" };
}

export interface ConsentCredentialStore {
  verifyDeviceKey(input: {
    userId: string;
    signerKeyId: string;
    message: string;
    signature: string;
  }): Promise<boolean>;
  withWebAuthnCredentialLock(
    input: { userId: string; credentialId: string },
    fn: (
      credential: PinnedWebAuthnCredential,
    ) => Promise<
      { ok: true; nextSignCounter: number } | { ok: false; reason: string }
    >,
  ): Promise<boolean>;
}

export function createEnclaveConsentVerifier(input: {
  userId: string;
  signerKeyId: string;
  credentialStore: ConsentCredentialStore;
}): ConsentVerifier {
  return {
    async verify(message, signature) {
      if (signature.type === "device_key") {
        return input.credentialStore.verifyDeviceKey({
          userId: input.userId,
          signerKeyId: input.signerKeyId,
          message,
          signature: signature.signature,
        });
      }
      return input.credentialStore.withWebAuthnCredentialLock(
        { userId: input.userId, credentialId: signature.credentialId },
        async (credential) => {
          const result = verifyWebAuthnConsentSignature({
            message,
            signature,
            credential,
          });
          return result.ok
            ? { ok: true, nextSignCounter: result.signCounter }
            : { ok: false, reason: result.reason };
        },
      );
    },
  };
}

export function buildConsentMessage(
  value: Omit<ProviderVisibleInputConsent, "signature">,
): string {
  return canonicaliseProviderVisibleConsentUnsigned(value);
}

export async function verifyProviderVisibleInputConsent(input: {
  consent: unknown;
  expected: {
    planId: string;
    subtaskId: string;
    providerId: string;
    modelId: string;
    inputHandleSetHash: string;
    enclaveNonce: string;
    pinnedSignerKeyId: string;
    revokedSignerKeyIds: ReadonlySet<string>;
  };
  verifier: ConsentVerifier;
  now: Date;
  seenConsentIds: Set<string>;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = ProviderVisibleInputConsentSchema.safeParse(input.consent);
  if (!parsed.success) return { ok: false, reason: "CONSENT_INVALID" };
  const consent = parsed.data;
  if (input.seenConsentIds.has(consent.consentId)) {
    return { ok: false, reason: "CONSENT_REPLAYED" };
  }
  if (new Date(consent.expiresAt).getTime() <= input.now.getTime()) {
    return { ok: false, reason: "CONSENT_EXPIRED" };
  }
  if (
    consent.signerKeyId !== input.expected.pinnedSignerKeyId ||
    input.expected.revokedSignerKeyIds.has(consent.signerKeyId)
  ) {
    return { ok: false, reason: "CONSENT_SIGNER_KEY_MISMATCH" };
  }
  const bindingMatches =
    consent.planId === input.expected.planId &&
    consent.subtaskId === input.expected.subtaskId &&
    consent.providerId === input.expected.providerId &&
    consent.modelId === input.expected.modelId &&
    consent.inputHandleSetHash === input.expected.inputHandleSetHash &&
    consent.enclaveNonce === input.expected.enclaveNonce;
  if (!bindingMatches) return { ok: false, reason: "CONSENT_BINDING_MISMATCH" };
  const { signature, ...unsigned } = consent;
  if (
    signature.type === "webauthn" &&
    signature.credentialId !== consent.signerKeyId
  ) {
    return { ok: false, reason: "CONSENT_SIGNER_KEY_MISMATCH" };
  }
  if (
    !(await input.verifier.verify(buildConsentMessage(unsigned), signature))
  ) {
    return { ok: false, reason: "CONSENT_SIGNATURE_INVALID" };
  }
  input.seenConsentIds.add(consent.consentId);
  return { ok: true };
}
