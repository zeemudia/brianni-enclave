import { describe, expect, it } from "vitest";
import { VALID_NITRO_FIXTURE, fixtureNitroDocument, fixtureNitroRootBundle } from "./fixtures/nitro-attestation";
import { verifyNitroAttestationDocument } from "../media/nitro-attestation";

describe("Nitro attestation verifier", () => {
  it("decodes a valid captured-style COSE_Sign1 document", () => {
    const result = verifyNitroAttestationDocument({
      rawDocument: fixtureNitroDocument("valid"),
      rootBundle: fixtureNitroRootBundle(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.pcr0).toBe(VALID_NITRO_FIXTURE.pcr0);
      expect(result.document.pcr8).toBe(VALID_NITRO_FIXTURE.pcr8);
      expect(result.document.nonce).toBe(VALID_NITRO_FIXTURE.nonce);
      expect(result.document.publicKeyId).toBe(VALID_NITRO_FIXTURE.publicKeyId);
    }
  });

  it.each([
    ["signature", fixtureNitroDocument("bad-signature"), fixtureNitroRootBundle()],
    ["root", fixtureNitroDocument("valid"), fixtureNitroRootBundle("wrong-root")],
    ["signing-ca", fixtureNitroDocument("valid"), fixtureNitroRootBundle("untrusted-signing-ca")],
    ["pcr0", fixtureNitroDocument("missing-pcr0"), fixtureNitroRootBundle()],
    ["pcr8", fixtureNitroDocument("missing-pcr8"), fixtureNitroRootBundle()],
    ["nonce", fixtureNitroDocument("mutated-nonce"), fixtureNitroRootBundle()],
    ["leafValidity", fixtureNitroDocument("expired-leaf"), fixtureNitroRootBundle()],
  ] as const)("fails closed on %s mutation", (_field, rawDocument, rootBundle) => {
    expect(
      verifyNitroAttestationDocument({
        rawDocument,
        rootBundle,
      }).ok,
    ).toBe(false);
  });
});
