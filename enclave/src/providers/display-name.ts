export interface ProviderDisplayNameConfig {
  id: string;
  displayName?: string | null;
}

const ACRONYM_BY_TOKEN = new Map<string, string>([
  ['ai', 'AI'],
  ['api', 'API'],
  ['aws', 'AWS'],
  ['gcp', 'GCP'],
  ['openai', 'OpenAI'],
  ['xai', 'xAI'],
]);

export function buildProviderDisplayNameMap(
  providers: readonly ProviderDisplayNameConfig[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const provider of providers) {
    out.set(
      provider.id,
      normaliseProviderDisplayName(provider.displayName, provider.id),
    );
  }
  return out;
}

export function resolveProviderDisplayName(
  providerId: string,
  displayNames?: ReadonlyMap<string, string>,
): string {
  return displayNames?.get(providerId) ?? humaniseProviderId(providerId);
}

function normaliseProviderDisplayName(
  displayName: string | null | undefined,
  providerId: string,
): string {
  const trimmed = displayName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : humaniseProviderId(providerId);
}

function humaniseProviderId(providerId: string): string {
  const tokens = providerId.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return providerId;
  return tokens.map(humaniseToken).join(' ');
}

function humaniseToken(token: string): string {
  const lower = token.toLowerCase();
  const acronym = ACRONYM_BY_TOKEN.get(lower);
  if (acronym) return acronym;
  return `${token.slice(0, 1).toUpperCase()}${token.slice(1).toLowerCase()}`;
}
