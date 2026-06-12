/**
 * Cross-platform sorted-JSON serialiser for envelope/AAD hash parity.
 *
 * Lifted verbatim (modulo TypeScript shape) from the sister project's
 * `apps/web/lib/encryption.ts`. iOS/Android native implementations and the
 * sister web client agree on this exact omission set:
 *   - null and undefined values are SKIPPED (match Android's
 *     buildSortedJsonString)
 *   - mimeType:"" is SKIPPED (match iOS/Android empty-string omission)
 *   - s3Parts is ALWAYS SKIPPED (not part of AAD; only used for S3 upload
 *     completion)
 *
 * Operates on the TOP LEVEL only — envelopes are flat objects, no nested
 * sorting needed. If callers ever pass nested objects, they are kept
 * as-is via JSON.stringify's default behavior.
 */
export function sortedJsonStringify(obj: Record<string, unknown>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const value = obj[key];
    if (value !== null && value !== undefined) {
      if (key === 'mimeType' && typeof value === 'string' && value === '') {
        continue;
      }
      if (key === 's3Parts') {
        continue;
      }
      sortedObj[key] = value;
    }
  }
  return JSON.stringify(sortedObj);
}
