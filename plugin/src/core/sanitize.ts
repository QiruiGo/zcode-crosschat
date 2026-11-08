/**
 * M1 core-store: free-form name -> safe path/key segment.
 *
 * 1:1 port of dsh sanitizeKey (state.js:64-99): NFC normalize -> trim ->
 * lowercase -> fold every non letter/number run to `-` -> strip edge dashes.
 * Unicode letters and digits survive, so CJK names stay distinct and readable;
 * an ASCII-only whitelist would silently merge them onto one shared mailbox.
 *
 * @module core/sanitize
 */
import { createHash } from 'node:crypto';

/** Longest key emitted before truncating and appending a digest. */
const MAX_KEY_LENGTH = 48;

/** Short stable digest, used to keep otherwise-colliding keys distinct. */
function keyDigest(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8);
}

/**
 * Fold a free-form name into a non-empty key safe as a single path segment.
 * A name with no letters or digits at all gets a digest rather than a shared
 * constant; over-long names are truncated with a digest appended, so names
 * sharing a long prefix stay distinct (CJK costs 3 bytes per char in UTF-8).
 */
export function sanitizeKey(name: string): string {
  const cleaned = name.normalize('NFC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned === '') return `k-${keyDigest(name)}`;
  const points = [...cleaned];
  if (points.length > MAX_KEY_LENGTH) {
    return `${points.slice(0, MAX_KEY_LENGTH).join('')}-${keyDigest(name)}`;
  }
  return cleaned;
}
