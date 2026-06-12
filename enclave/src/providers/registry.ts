import { verify, createPublicKey } from "node:crypto";
import { canonicalRegistrySigningInput } from "./canonical-registry";
import {
  ModelCapabilitySchema,
  type ChatProcessor,
  type ModelEndpointFamily,
  type ModelModality,
  type NativeWebSearchCapability,
  type ModelQualityTier,
  type ModelStrength,
} from "@calypso/chat-types";
import { OpenAIProcessor } from "./adapters/openai-v1";
import { AnthropicProcessor } from "./adapters/anthropic-v1";
import { GoogleV1ChatProcessor } from "./adapters/google-v1";
import {
  buildProviderDisplayNameMap,
  resolveProviderDisplayName,
} from "./display-name";

export interface ModelCapabilityMetadata {
  strengths: ModelStrength[];
  strengthQuality?: Array<{ strength: ModelStrength; tier: ModelQualityTier }>;
  modalities: ModelModality[];
  endpointFamily?: ModelEndpointFamily;
  costTier: "low" | "medium" | "high";
  latencyTier: "fast" | "standard" | "slow";
  routingStatus?: "enabled" | "registered_pending_gateway" | "disabled";
  requiredGatewayTools?: string[];
  nativeWebSearch?: NativeWebSearchCapability;
}

export interface ModelConfig {
  id: string;
  displayName: string;
  contextWindow?: number;
  capabilities?: ModelCapabilityMetadata;
}

export interface CustomModelConfig {
  enabled: boolean;
  planRequired?: "PRO" | "MAX";
  modelIdPattern?: string;
  placeholder?: string;
}

export interface ProviderConfig {
  id: string;
  displayName?: string;
  adapter: string;
  baseUrl: string;
  apiKeyEnvVar: string;
  customModel?: CustomModelConfig;
  models: ModelConfig[];
}

export interface ProviderRegistry {
  version: number;
  providers: ProviderConfig[];
  signature: string;
}

/**
 * Minimum acceptable provider-registry version, baked into the measured
 * enclave image (covered by PCR0/attestation). loadAndVerifyRegistry rejects
 * any registry whose version is strictly below this floor.
 *
 * IMPORTANT — scope of protection: this excludes only versions BELOW the
 * floor. At the initial value (1, the lowest meaningful version) it therefore
 * excludes nothing yet — a compromised host can still replay any past
 * registry whose version is >= 1. Practical anti-rollback requires the
 * operator to ADVANCE this floor to the current registry version on each
 * rotation that must invalidate a superseded registry; because the constant
 * is measured, raising it is itself an EIF rebuild + PCR0 rotation. The signed
 * envelope binds the version to the signature (see
 * canonicalRegistrySigningInput), so an attacker cannot bypass the floor by
 * relabelling an old registry with a higher version.
 */
export const MIN_REGISTRY_VERSION = 1;

// Canonical signing-input serialization lives in ./canonical-registry so the
// signer (scripts/sign-registry.ts) and this verifier share one source of
// truth. Re-exported for tests and call sites that import it from here.
export { canonicalRegistrySigningInput } from "./canonical-registry";

/**
 * Safe subset enforced on `customModel.modelIdPattern` before it is ever
 * compiled with `new RegExp()` (getProviderForCustomModel). The registry is
 * Ed25519-signed, so this is defense-in-depth against a compromised signing
 * pipeline: anchored, no groups, no alternation, no escapes, no unbounded
 * quantifiers. Without groups a quantifier can only apply to a single
 * char/class, so matching is linear — nested quantifiers (the classic ReDoS
 * shape, e.g. `(a+)+`) are structurally impossible.
 */
const MODEL_ID_PATTERN_MAX_LENGTH = 128;
// Literal id characters plus the only metacharacters the subset needs:
// anchors (^ $), character classes ([ ] -), and bounded {m,n} repetition.
// Deliberately EXCLUDED: ( ) | \ * + ? — no groups, no alternation, no
// escapes, no unbounded quantifiers.
const MODEL_ID_PATTERN_ALLOWED = /^[A-Za-z0-9[\]{}.,:_^$-]+$/;

/**
 * Validate a customModel.modelIdPattern against the safe subset above.
 * Throws a descriptive Error if the pattern is unsafe or does not compile.
 */
export function validateModelIdPattern(pattern: string): void {
  if (typeof pattern !== "string") {
    throw new Error("modelIdPattern must be a string");
  }
  if (
    pattern.length === 0 ||
    pattern.length > MODEL_ID_PATTERN_MAX_LENGTH
  ) {
    throw new Error(
      `modelIdPattern length must be 1-${MODEL_ID_PATTERN_MAX_LENGTH} characters`,
    );
  }
  if (!pattern.startsWith("^") || !pattern.endsWith("$") || pattern.length < 3) {
    throw new Error("modelIdPattern must be anchored with ^...$");
  }
  if (!MODEL_ID_PATTERN_ALLOWED.test(pattern)) {
    throw new Error(
      "modelIdPattern contains characters outside the safe subset " +
        "(no groups, alternation, escapes, or unbounded quantifiers)",
    );
  }
  try {
    new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `modelIdPattern does not compile: ${(err as Error).message}`,
    );
  }
}

let loadedProviders: ProviderConfig[] | null = null;
let modelIndex: Map<
  string,
  { provider: ProviderConfig; model: ModelConfig }
> | null = null;
let providerIndex: Map<string, ProviderConfig> | null = null;

/**
 * Load and verify the provider registry.
 * Rejects if signature is missing or invalid.
 */
export function loadAndVerifyRegistry(
  registry: unknown,
  verifyKeyPem: string,
): ProviderConfig[] {
  if (!registry || typeof registry !== "object") {
    throw new Error("Invalid provider registry format");
  }

  const reg = registry as Record<string, unknown>;

  if (!reg.signature || typeof reg.signature !== "string") {
    throw new Error("MISSING_REGISTRY_SIGNATURE");
  }

  if (!Array.isArray(reg.providers)) {
    throw new Error("Invalid provider registry: missing providers array");
  }

  // Anti-rollback: the version must be an integer at or above the baked
  // floor. This rejects a host replaying an older signed registry (e.g. one
  // routing to a since-deprecated/compromised provider endpoint) even though
  // its signature was valid at the time.
  if (typeof reg.version !== "number" || !Number.isInteger(reg.version)) {
    throw new Error("INVALID_REGISTRY_VERSION");
  }
  if (reg.version < MIN_REGISTRY_VERSION) {
    throw new Error("REGISTRY_VERSION_BELOW_MINIMUM");
  }

  // Verify the signature over the canonical { version, providers } envelope.
  // Because the version is inside the signed bytes, an attacker cannot take an
  // old validly-signed registry and relabel it with a higher version to clear
  // the floor — the signature would no longer match.
  const keyObject = createPublicKey({
    key: verifyKeyPem,
    format: "pem",
    type: "spki",
  });
  const valid = verify(
    null,
    canonicalRegistrySigningInput(reg.version, reg.providers),
    keyObject,
    Buffer.from(reg.signature as string, "base64"),
  );

  if (!valid) {
    throw new Error("INVALID_REGISTRY_SIGNATURE");
  }

  const providers = reg.providers as ProviderConfig[];
  validateCapabilityMetadata(providers);
  validateCustomModelPatterns(providers);
  console.info(
    `[registry] Provider registry loaded and verified (${providers.length} providers)`,
  );
  return providers;
}

function validateCapabilityMetadata(providers: ProviderConfig[]): void {
  for (const provider of providers) {
    for (const model of provider.models) {
      if (!model.capabilities) continue;
      try {
        ModelCapabilitySchema.parse({
          modelId: model.id,
          providerId: provider.id,
          ...model.capabilities,
          maxContextTokens: model.contextWindow,
        });
      } catch (err) {
        throw new Error(
          `Invalid provider registry capability metadata for ${provider.id}/${model.id}: ${(err as Error).message}`,
        );
      }
      const endpointFamily = model.capabilities.endpointFamily ?? "chat";
      if (
        endpointFamily !== "chat" &&
        (model.capabilities.requiredGatewayTools ?? []).length === 0
      ) {
        throw new Error(
          `Invalid provider registry capability metadata for ${provider.id}/${model.id}: non-chat model requires gateway tools`,
        );
      }
    }
  }
}

function validateCustomModelPatterns(providers: ProviderConfig[]): void {
  for (const provider of providers) {
    const pattern = provider.customModel?.modelIdPattern;
    if (pattern === undefined) continue;
    try {
      validateModelIdPattern(pattern);
    } catch (err) {
      throw new Error(
        `Invalid provider registry modelIdPattern for ${provider.id}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Initialize the registry from a registry object and verification key.
 */
export function initRegistry(registry: unknown, verifyKeyPem: string): void {
  loadedProviders = loadAndVerifyRegistry(registry, verifyKeyPem);
  modelIndex = new Map();
  providerIndex = new Map();

  for (const provider of loadedProviders) {
    providerIndex.set(provider.id, provider);
    for (const model of provider.models) {
      modelIndex.set(model.id, { provider, model });
    }
  }
}

/**
 * Look up a provider + model by model ID.
 * Throws if the model isn't in the registry.
 */
export function getProviderForModel(modelId: string): {
  provider: ProviderConfig;
  model: ModelConfig;
} {
  if (!modelIndex) {
    throw new Error("Provider registry not initialized");
  }

  const entry = modelIndex.get(modelId);
  if (!entry) {
    throw new Error(`Model '${modelId}' not found in provider registry`);
  }

  return entry;
}

export function getProviderById(providerId: string): ProviderConfig {
  if (!providerIndex) {
    throw new Error("Provider registry not initialized");
  }

  const provider = providerIndex.get(providerId);
  if (!provider) {
    throw new Error(`Provider '${providerId}' not found in provider registry`);
  }
  return provider;
}

export function getProviderForCustomModel(
  providerId: string,
  modelId: string,
): {
  provider: ProviderConfig;
  model: ModelConfig;
  customModel: NonNullable<ProviderConfig["customModel"]>;
} {
  const provider = getProviderById(providerId);
  const customModel = provider.customModel;
  if (!customModel?.enabled) {
    throw new Error(`Provider '${providerId}' does not allow custom model IDs`);
  }

  if (customModel.modelIdPattern) {
    const re = new RegExp(customModel.modelIdPattern);
    if (!re.test(modelId)) {
      throw new Error(
        `Custom model '${modelId}' is not allowed for provider ${providerId}`,
      );
    }
  }

  return {
    provider,
    model: {
      id: modelId,
      displayName: modelId,
    },
    customModel,
  };
}

/**
 * Get all providers for the models catalog.
 */
export function getAllProviders(): ProviderConfig[] {
  if (!loadedProviders) {
    throw new Error("Provider registry not initialized");
  }
  return loadedProviders;
}

/**
 * Create a ChatProcessor for a given provider config.
 * Resolves the adapter type to the appropriate processor class.
 */
export function createProcessor(
  provider: ProviderConfig,
  apiKey: string,
): ChatProcessor {
  const providerDisplayNames = buildProviderDisplayNameMap([provider]);
  const providerMetadata = {
    providerId: provider.id,
    providerName: resolveProviderDisplayName(provider.id, providerDisplayNames),
  };
  // On Nitro, the vsock-proxy-bridge intercepts DNS + net.connect to route
  // connections through local vsock bridges. URLs stay as https:// so TLS
  // terminates inside the enclave (the host never sees plaintext).
  switch (provider.adapter) {
    case "openai_v1":
      return new OpenAIProcessor(provider.baseUrl, apiKey, providerMetadata);
    case "anthropic_v1":
      return new AnthropicProcessor(provider.baseUrl, apiKey, providerMetadata);
    case "google_v1":
      return new GoogleV1ChatProcessor(
        apiKey,
        provider.baseUrl,
        providerMetadata,
      );
    default:
      throw new Error(`Unknown adapter: ${provider.adapter}`);
  }
}
