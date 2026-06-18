import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { signConnectorCatalog } from "../../../../scripts/sign-connectors";
import { loadAndVerifyConnectorCatalog } from "../registry";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
const unsigned = {
  version: 1,
  connectors: [
    {
      id: "google-calendar",
      displayName: "Google Calendar",
      provider: "google",
      platforms: ["web", "ios", "android"],
      oauthScopes: ["https://www.googleapis.com/auth/calendar.events"],
      operations: [
        // NOTE: `destructive` AND `binary` omitted → they rely on schema defaults.
        { id: "list_events", mutating: false, requiredScope: "calendar.readonly", paramsSchema: {} },
      ],
      mcp: null,
    },
  ],
};

describe("signer ↔ registry agreement (raw pre-default shape, Finding #5)", () => {
  it("signer output verifies against the registry", () => {
    const signed = signConnectorCatalog(unsigned, privateKey);
    expect(() => loadAndVerifyConnectorCatalog(signed, pem)).not.toThrow();
  });

  it("does NOT inject defaults into the signed file (forward-compat)", () => {
    const signed = signConnectorCatalog(unsigned, privateKey);
    const op = signed.connectors[0].operations[0];
    expect(op).not.toHaveProperty("destructive");
    expect(op).not.toHaveProperty("binary");
    expect(loadAndVerifyConnectorCatalog(signed, pem)[0].operations[0].binary).toBe(false);
  });
});
