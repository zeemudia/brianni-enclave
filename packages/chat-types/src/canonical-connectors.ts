/**
 * Canonical serialization of the signed connector-catalog envelope.
 *
 * Single source of truth shared by the signer (scripts/sign-connectors.ts) and
 * the in-enclave verifier (enclave/src/connectors/registry.ts). Both MUST
 * produce byte-identical signing input or a valid signature fails verification.
 *
 * Mirrors canonical-skill-prompts.ts (recursive object-key sort; array order
 * preserved) with a DISTINCT domain tag, so a provider-registry or
 * skill-prompts signature can never be replayed as a connectors signature even
 * under the same offline signing key. The version is inside the signed bytes,
 * defeating relabel-an-old-catalog-with-a-higher-version replay.
 *
 * No heavy dependencies, so the standalone signing script can import it without
 * dragging in the enclave runtime.
 */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => canonicalize(element));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Domain tag binding a signature to the connectors protocol (v1). */
export const CONNECTORS_SIGNING_DOMAIN = "calypso.connectors.v1";

/**
 * Deterministic byte serialization of the connectors signing envelope. Stable
 * regardless of object key insertion order in the source JSON.
 */
export function canonicalConnectorsSigningInput(
  version: number,
  connectors: unknown,
): Buffer {
  return Buffer.from(
    JSON.stringify(
      canonicalize({
        domain: CONNECTORS_SIGNING_DOMAIN,
        version,
        connectors,
      }),
    ),
  );
}
