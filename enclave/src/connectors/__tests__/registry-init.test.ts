import { describe, expect, it, beforeEach } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { canonicalConnectorsSigningInput } from "@calypso/chat-types";
import {
  initConnectorRegistry,
  isConnectorRegistryLoaded,
  getConnectorOperation,
  __resetConnectorRegistryForTest,
} from "../registry";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
const connectors = [
  {
    id: "google-calendar", displayName: "Google Calendar", provider: "google",
    platforms: ["web"], oauthScopes: ["https://www.googleapis.com/auth/calendar.events"],
    operations: [{ id: "list_events", mutating: false, requiredScope: "calendar.readonly", paramsSchema: {} }],
    mcp: null,
  },
];
const signed = (version = 1) => ({
  version, connectors,
  signature: edSign(null, canonicalConnectorsSigningInput(version, connectors), privateKey).toString("base64"),
});

describe("connector registry init (fail-closed boot)", () => {
  beforeEach(() => __resetConnectorRegistryForTest());

  it("reports not-loaded before init, loaded after", () => {
    expect(isConnectorRegistryLoaded()).toBe(false);
    initConnectorRegistry(signed(), pem);
    expect(isConnectorRegistryLoaded()).toBe(true);
  });

  it("an unloaded registry returns null (distinct from a loaded miss)", () => {
    expect(isConnectorRegistryLoaded()).toBe(false);
    expect(getConnectorOperation("google-calendar", "list_events")).toBeNull();
  });

  it("a tampered catalog throws at init (boot aborts, never serves unverified data)", () => {
    const bad = signed();
    bad.connectors[0].operations.push({ id: "delete_event", mutating: true, requiredScope: "x", paramsSchema: {} } as never);
    expect(() => initConnectorRegistry(bad, pem)).toThrow(/SIGNATURE/);
    expect(isConnectorRegistryLoaded()).toBe(false); // stayed unloaded
  });
});
