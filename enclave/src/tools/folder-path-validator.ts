export const MAX_FOLDER_PATH_SEGMENT_BYTES = 256;

const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f-\x9f]/u;
const FORMAT_CONTROL_PATTERN = /\p{Cf}/u;

export function isBoundedFolderPathSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment === '.' || segment === '..') return false;
  if (segment.includes('/') || segment.includes('\\')) return false;
  if (segment.trim() !== segment) return false;
  if (segment.normalize('NFC') !== segment) return false;
  if (CONTROL_CHARACTER_PATTERN.test(segment)) return false;
  if (FORMAT_CONTROL_PATTERN.test(segment)) return false;
  return (
    Buffer.byteLength(segment, 'utf8') <= MAX_FOLDER_PATH_SEGMENT_BYTES
  );
}
