import { verify, createPublicKey } from "node:crypto";
import {
  ConnectorCatalogSchema,
  MIN_CONNECTOR_CATALOG_VERSION,
  canonicalConnectorsSigningInput,
  type ConnectorDescriptor,
  type ConnectorOperation,
} from "@calypso/chat-types";

/**
 * Load and verify a signed connector catalog.
 *
 * The signature is verified over the RAW pre-default catalog shape
 * (`cat.version`, `cat.connectors` as received from the host), NOT over the
 * Zod-parsed/defaulted copy — this mirrors sign-skill-prompts.ts and the
 * provider registry's sign-registry.ts, which sign the bundle exactly as read
 * from the file. Schema evolution adding a field with a default therefore
 * CANNOT invalidate an already-signed catalog (Finding #5).
 *
 * Anti-rollback: the version must be an integer at or above the baked floor
 * (MIN_CONNECTOR_CATALOG_VERSION). The version is inside the signed bytes so
 * an attacker cannot relabel an old catalog with a higher version to clear the
 * floor — the signature would no longer match.
 */
export function loadAndVerifyConnectorCatalog(
  catalog: unknown,
  verifyKeyPem: string,
): ConnectorDescriptor[] {
  if (!catalog || typeof catalog !== "object") {
    throw new Error("Invalid connector catalog format");
  }

  const cat = catalog as Record<string, unknown>;

  if (!cat.signature || typeof cat.signature !== "string") {
    throw new Error("MISSING_CATALOG_SIGNATURE");
  }

  if (typeof cat.version !== "number" || !Number.isInteger(cat.version)) {
    throw new Error("INVALID_CATALOG_VERSION");
  }
  if (cat.version < MIN_CONNECTOR_CATALOG_VERSION) {
    throw new Error("CATALOG_VERSION_BELOW_MINIMUM");
  }

  // Schema-validate so a malformed catalog (duplicate ops, invalid fields) fails
  // loudly AND produces a typed ConnectorDescriptor[] for the in-memory registry.
  // The SIGNATURE is verified over the RAW pre-default shape below — NOT over
  // `parsed` — so adding a future schema field with a default never invalidates
  // an existing signature.
  const parsed = ConnectorCatalogSchema.parse(catalog);

  const keyObject = createPublicKey({ key: verifyKeyPem, format: "pem", type: "spki" });
  const valid = verify(
    null,
    // RAW connectors/version, byte-for-byte what the offline signer signed
    // (Task 12 signs the same raw author shape, not a Zod-parsed one).
    canonicalConnectorsSigningInput(cat.version, cat.connectors),
    keyObject,
    Buffer.from(cat.signature as string, "base64"),
  );

  if (!valid) {
    throw new Error("INVALID_CATALOG_SIGNATURE");
  }

  console.info(
    `[connectors] catalog loaded and verified (${parsed.connectors.length} connectors)`,
  );
  return parsed.connectors;
}

let loadedConnectors: ConnectorDescriptor[] | null = null;
let connectorIndex: Map<string, ConnectorDescriptor> | null = null;
let loadedCatalogVersion: number | null = null;

/**
 * Initialize the in-memory connector registry from a signed catalog object and
 * verification key. Mirrors initRegistry in providers/registry.ts.
 */
export function initConnectorRegistry(catalog: unknown, verifyKeyPem: string): void {
  loadedConnectors = loadAndVerifyConnectorCatalog(catalog, verifyKeyPem);
  connectorIndex = new Map(loadedConnectors.map((c) => [c.id, c]));
  // Surface the loaded catalog version (validated as an integer ≥ the measured
  // floor inside loadAndVerifyConnectorCatalog) so the local health probe can
  // report it for an objective, Phase-2-independent rotation verification.
  loadedCatalogVersion = (catalog as { version: number }).version;
}

/**
 * Look up a connector descriptor by id.
 * Returns null if the registry has not been initialized or the id is unknown.
 */
export function getConnector(connectorId: string): ConnectorDescriptor | null {
  return connectorIndex?.get(connectorId) ?? null;
}

/**
 * Look up a specific operation within a connector.
 * Returns null if either the connector or the operation is unknown.
 */
export function getConnectorOperation(
  connectorId: string,
  operationId: string,
): ConnectorOperation | null {
  const connector = getConnector(connectorId);
  if (!connector) return null;
  return connector.operations.find((op) => op.id === operationId) ?? null;
}

/**
 * Return all loaded connector descriptors.
 * Returns null if the registry has not been initialized.
 */
export function getAllConnectors(): ConnectorDescriptor[] | null {
  return loadedConnectors;
}

/**
 * Returns true if the connector registry has been initialized via
 * initConnectorRegistry. Mirrors the provider registry's isRegistryLoaded
 * pattern (if present) and is used by the boot health check to confirm the
 * fail-closed gate was passed.
 */
export function isConnectorRegistryLoaded(): boolean {
  return connectorIndex !== null;
}

/**
 * Return the version of the currently-loaded connector catalog, or null when
 * the registry has not been initialized. The version is the anti-rollback
 * integer carried inside the signed catalog bytes (validated against the baked
 * floor in loadAndVerifyConnectorCatalog), so it is a trustworthy identity for
 * the loaded catalog. Surfaced on the enclave's local HEALTH_PONG so a rotation
 * verifier can confirm the catalog loaded WITHOUT driving a connector.* agent
 * turn (Phase-2-independent). Names no connector — purely a status integer.
 */
export function getConnectorCatalogVersion(): number | null {
  return loadedCatalogVersion;
}

/**
 * Test-only: reset the in-memory registry so each test starts from a clean
 * state. MUST NOT be called in production code.
 */
export function __resetConnectorRegistryForTest(): void {
  loadedConnectors = null;
  connectorIndex = null;
  loadedCatalogVersion = null;
}
