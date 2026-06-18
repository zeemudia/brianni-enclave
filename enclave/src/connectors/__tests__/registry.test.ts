import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { canonicalConnectorsSigningInput } from "@calypso/chat-types";

import {
  loadAndVerifyConnectorCatalog,
  getConnectorOperation,
  initConnectorRegistry,
  isConnectorRegistryLoaded,
  getConnectorCatalogVersion,
  __resetConnectorRegistryForTest,
} from "../registry";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const verifyKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

function signedCatalog(version = 1) {
  const connectors = [
    {
      id: "google-calendar",
      displayName: "Google Calendar",
      provider: "google",
      platforms: ["web", "ios", "android"],
      oauthScopes: ["https://www.googleapis.com/auth/calendar.events"],
      operations: [
        { id: "list_events", mutating: false, destructive: false, requiredScope: "calendar.readonly", paramsSchema: {} },
        { id: "delete_event", mutating: true, destructive: true, concurrency: "etag", requiredScope: ["calendar.events"], paramsSchema: {} },
      ],
      mcp: null,
    },
  ];
  const signature = edSign(null, canonicalConnectorsSigningInput(version, connectors), privateKey).toString("base64");
  return { version, connectors, signature };
}

describe("loadAndVerifyConnectorCatalog", () => {
  it("loads + verifies a correctly signed catalog", () => {
    const connectors = loadAndVerifyConnectorCatalog(signedCatalog(), verifyKeyPem);
    expect(connectors).toHaveLength(1);
    expect(connectors[0].id).toBe("google-calendar");
  });

  it("rejects a missing signature", () => {
    const { signature: _omit, ...unsigned } = signedCatalog();
    expect(() => loadAndVerifyConnectorCatalog(unsigned, verifyKeyPem)).toThrow(/SIGNATURE/);
  });

  it("rejects a tampered catalog (operation added after signing)", () => {
    const cat = signedCatalog();
    cat.connectors[0].operations.push({
      id: "create_event", mutating: true, destructive: false, requiredScope: "calendar.events", paramsSchema: {},
    } as never);
    expect(() => loadAndVerifyConnectorCatalog(cat, verifyKeyPem)).toThrow(/SIGNATURE/);
  });

  it("rejects a version below the measured floor", () => {
    expect(() => loadAndVerifyConnectorCatalog(signedCatalog(0), verifyKeyPem)).toThrow(/VERSION/);
  });

  it("refuses a VALIDLY-signed catalog with duplicate operation ids (Finding R1-4)", () => {
    const connectors = [
      {
        id: "google-calendar", displayName: "Google Calendar", provider: "google",
        platforms: ["web"], oauthScopes: ["https://www.googleapis.com/auth/calendar.events"],
        operations: [
          { id: "list_events", mutating: false, requiredScope: "calendar.readonly", paramsSchema: {} },
          { id: "list_events", mutating: false, requiredScope: "calendar.readonly", paramsSchema: {} },
        ],
        mcp: null,
      },
    ];
    const signature = edSign(null, canonicalConnectorsSigningInput(1, connectors), privateKey).toString("base64");
    expect(() =>
      loadAndVerifyConnectorCatalog({ version: 1, connectors, signature }, verifyKeyPem),
    ).toThrow(/unique|operation/i);
  });
});

describe("connector registry status getters (rotation-verify probe)", () => {
  it("reports unloaded + null version before init, loaded + version after init", () => {
    __resetConnectorRegistryForTest();
    expect(isConnectorRegistryLoaded()).toBe(false);
    expect(getConnectorCatalogVersion()).toBeNull();

    initConnectorRegistry(signedCatalog(2), verifyKeyPem);
    expect(isConnectorRegistryLoaded()).toBe(true);
    expect(getConnectorCatalogVersion()).toBe(2);
  });

  it("clears status back to unloaded + null version on reset", () => {
    initConnectorRegistry(signedCatalog(3), verifyKeyPem);
    expect(isConnectorRegistryLoaded()).toBe(true);
    expect(getConnectorCatalogVersion()).toBe(3);

    __resetConnectorRegistryForTest();
    expect(isConnectorRegistryLoaded()).toBe(false);
    expect(getConnectorCatalogVersion()).toBeNull();
  });
});

describe("getConnectorOperation", () => {
  it("returns the catalog operation for a connector+op", () => {
    initConnectorRegistry(signedCatalog(), verifyKeyPem);
    const op = getConnectorOperation("google-calendar", "delete_event");
    expect(op).not.toBeNull();
    expect(op!.mutating).toBe(true);
    expect(op!.destructive).toBe(true);
  });

  it("returns null for an unknown connector or operation", () => {
    initConnectorRegistry(signedCatalog(), verifyKeyPem);
    expect(getConnectorOperation("google-calendar", "nope")).toBeNull();
    expect(getConnectorOperation("nope", "list_events")).toBeNull();
  });
});
