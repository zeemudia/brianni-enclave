/**
 * Canonical serialization of the signed provider-registry envelope.
 *
 * Single source of truth shared by the signer (scripts/sign-registry.ts) and
 * the in-enclave verifier (registry.ts → loadAndVerifyRegistry). Both MUST
 * produce byte-identical signing input, otherwise a valid signature fails
 * verification.
 *
 * We sign the `{ version, providers }` envelope (not the providers array
 * alone) so the version is bound to the signature — defeating the
 * relabel-an-old-registry-with-a-higher-version replay. To make byte-equality
 * independent of JSON key insertion order (which a raw JSON.stringify would
 * leak from however providers.json happened to be serialized), object keys are
 * sorted recursively. Array order is preserved — provider ordering is
 * meaningful signed content, only object KEYS are normalized.
 *
 * This module has NO heavy dependencies (no adapters, no @calypso/* imports)
 * so the standalone signing script can import it without dragging in the
 * enclave runtime.
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

/**
 * Deterministic byte serialization of the registry signing envelope. Stable
 * regardless of object key insertion order in the source registry JSON.
 */
export function canonicalRegistrySigningInput(
  version: number,
  providers: unknown,
): Buffer {
  return Buffer.from(JSON.stringify(canonicalize({ version, providers })));
}
