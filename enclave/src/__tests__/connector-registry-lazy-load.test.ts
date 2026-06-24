import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalConnectorsSigningInput } from "@calypso/chat-types";
import { encodeFrame, decodeFrame, MSG } from "../vsock";
import {
  __resetConnectorRegistryForTest,
  isConnectorRegistryLoaded,
} from "../connectors/registry";

vi.mock("../connectors-client", () => ({
  fetchConnectorsFromBroker: vi.fn(),
}));

import { fetchConnectorsFromBroker } from "../connectors-client";
import { EnclaveRouter } from "../index";

const mockedFetchConnectorsFromBroker = vi.mocked(fetchConnectorsFromBroker);

const oldEnv = {
  NODE_ENV: process.env.NODE_ENV,
  MOCK_KMS: process.env.MOCK_KMS,
  CONNECTORS_PATH: process.env.CONNECTORS_PATH,
  CONNECTORS_VERIFY_KEY_PATH: process.env.CONNECTORS_VERIFY_KEY_PATH,
};

let tempDir: string | null = null;

function signedConnectorCatalog(version: number) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const verifyKeyPem = publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const connectors = [
    {
      id: "google-calendar",
      displayName: "Google Calendar",
      provider: "google",
      platforms: ["web", "ios", "android"],
      oauthScopes: ["https://www.googleapis.com/auth/calendar.events"],
      operations: [
        {
          id: "list_events",
          mutating: false,
          destructive: false,
          requiredScope: "calendar.readonly",
          paramsSchema: {},
        },
      ],
      mcp: null,
    },
  ];
  const signature = edSign(
    null,
    canonicalConnectorsSigningInput(version, connectors),
    privateKey,
  ).toString("base64");
  return {
    verifyKeyPem,
    catalogJson: JSON.stringify({ version, connectors, signature }),
  };
}

async function health(router: EnclaveRouter) {
  const frames: Buffer[] = [];
  for await (const frame of router.handleMessage(
    encodeFrame(MSG.HEALTH_PING, Buffer.alloc(0)),
  )) {
    frames.push(frame);
  }
  return JSON.parse(decodeFrame(frames[0]).payload.toString());
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetConnectorRegistryForTest();
  tempDir = mkdtempSync(join(tmpdir(), "calypso-connectors-test-"));
  process.env.NODE_ENV = "production";
  delete process.env.MOCK_KMS;
  delete process.env.CONNECTORS_PATH;
});

afterEach(() => {
  __resetConnectorRegistryForTest();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("EnclaveRouter connector registry lazy loading", () => {
  it("retries broker-backed connector catalog loading on health after a boot-time miss", async () => {
    const { verifyKeyPem, catalogJson } = signedConnectorCatalog(7);
    const verifyKeyPath = join(tempDir!, "connectors-verify-key.pem");
    writeFileSync(verifyKeyPath, verifyKeyPem);
    process.env.CONNECTORS_VERIFY_KEY_PATH = verifyKeyPath;
    mockedFetchConnectorsFromBroker
      .mockRejectedValueOnce(new Error("connectors-broker not listening yet"))
      .mockResolvedValueOnce(catalogJson);

    const router = new EnclaveRouter();
    await router["loadConnectorRegistry"]();
    expect(isConnectorRegistryLoaded()).toBe(false);

    const afterBrokerReady = await health(router);

    expect(mockedFetchConnectorsFromBroker).toHaveBeenCalledTimes(2);
    expect(afterBrokerReady.connectorRegistryLoaded).toBe(true);
    expect(afterBrokerReady.connectorCatalogVersion).toBe(7);
  });

  it("reports the registry unloaded when retry still cannot reach the broker", async () => {
    const { verifyKeyPem } = signedConnectorCatalog(7);
    const verifyKeyPath = join(tempDir!, "connectors-verify-key.pem");
    writeFileSync(verifyKeyPath, verifyKeyPem);
    process.env.CONNECTORS_VERIFY_KEY_PATH = verifyKeyPath;
    mockedFetchConnectorsFromBroker.mockRejectedValue(
      new Error("connectors-broker not listening yet"),
    );

    const router = new EnclaveRouter();
    await router["loadConnectorRegistry"]();

    const stillUnavailable = await health(router);

    expect(mockedFetchConnectorsFromBroker).toHaveBeenCalledTimes(2);
    expect(stillUnavailable.connectorRegistryLoaded).toBe(false);
    expect(stillUnavailable.connectorCatalogVersion).toBeNull();
  });
});
