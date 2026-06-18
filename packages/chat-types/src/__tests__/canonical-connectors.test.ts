import { describe, expect, it } from "vitest";
import {
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
} from "node:crypto";

import {
  canonicalConnectorsSigningInput,
  CONNECTORS_SIGNING_DOMAIN,
} from "../canonical-connectors";
import { canonicalSkillPromptsSigningInput } from "../canonical-skill-prompts";

const connectors = [
  { id: "google-calendar", operations: [{ id: "list_events", mutating: false }] },
];

describe("canonicalConnectorsSigningInput", () => {
  it("is stable regardless of source object key order", () => {
    const a = canonicalConnectorsSigningInput(1, [
      { id: "x", operations: [{ mutating: false, id: "op" }] },
    ]);
    const b = canonicalConnectorsSigningInput(1, [
      { operations: [{ id: "op", mutating: false }], id: "x" },
    ]);
    expect(a.equals(b)).toBe(true);
  });

  it("preserves array order (operations are ordered)", () => {
    const a = canonicalConnectorsSigningInput(1, [{ ops: ["a", "b"] }]);
    const b = canonicalConnectorsSigningInput(1, [{ ops: ["b", "a"] }]);
    expect(a.equals(b)).toBe(false);
  });

  it("binds the connectors domain tag", () => {
    expect(canonicalConnectorsSigningInput(1, connectors).toString()).toContain(
      CONNECTORS_SIGNING_DOMAIN,
    );
  });

  it("is domain-separated from skill-prompts (no cross-protocol replay)", () => {
    const connectorsInput = canonicalConnectorsSigningInput(1, connectors);
    const promptsInput = canonicalSkillPromptsSigningInput(1, connectors);
    expect(connectorsInput.equals(promptsInput)).toBe(false);
  });
});

describe("Ed25519 sign/verify round trip + anti-rollback", () => {
  it("verifies a correctly signed catalog and rejects tamper", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const input = canonicalConnectorsSigningInput(1, connectors);
    const signature = edSign(null, input, privateKey);

    const pubPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const keyObject = createPublicKey({ key: pubPem, format: "pem", type: "spki" });

    expect(edVerify(null, input, keyObject, signature)).toBe(true);

    // Bumping the version (replay an old catalog under a new label) breaks it.
    const tampered = canonicalConnectorsSigningInput(2, connectors);
    expect(edVerify(null, tampered, keyObject, signature)).toBe(false);
  });
});
