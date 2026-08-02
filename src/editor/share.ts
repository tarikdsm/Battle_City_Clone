// src/editor/share.ts — export, import and share codes (arch §9, content §5).
//
// A custom stage leaves this app in one of two shapes:
//
//   · a **pretty JSON file**, for keeping and for diffing;
//   · a **share string** `BC1.<base64url(minified JSON)>`, for pasting into a
//     chat window.
//
// Both come back through {@link importText}, which is the whole import surface:
// an author with a file open should be able to paste its contents into the same
// box a share code goes in, without first working out which kind of text it is.
//
// ## Why every failure has a sentence attached
//
// Arch §9: "invalid custom levels fail with a user-readable reason". A share
// code is the one input to this game that arrives from a stranger, over a
// medium that mangles text — chat clients wrap lines, forums eat underscores,
// people paste half of it. So every stage of the decode answers in English, and
// once the payload is a JSON object the answer stops being ours: `validateLevel`
// already writes the best sentence anybody could about a level, and its
// messages come through **verbatim**.
//
// Pure and DOM-free. `btoa`/`atob` and `TextEncoder`/`TextDecoder` are the only
// platform APIs here, all four of them present in browsers and in the node
// environment the tests run under (no new dependencies — plan constraints).

import type { LevelData } from '../core/types';
import { validateLevel } from '../levels/schema';

/**
 * The format tag. Content §5: "future format versions bump the `BC1` prefix;
 * v1 readers reject unknown prefixes with a clear message."
 */
export const SHARE_PREFIX = 'BC1';

/** Anything shaped like `<tag>.<payload>` — so `BC2.` can be named, not guessed. */
const TAGGED = /^([A-Za-z]{2}\d+)\.(.*)$/s;

export type ImportResult =
  { ok: true; level: LevelData } | { ok: false; errors: string[] };

function fail(...errors: string[]): ImportResult {
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// --- base64url -------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * UTF-8 → base64url, unpadded.
 *
 * `btoa` takes *Latin-1*, so a stage called "Pöytä" would throw an
 * `InvalidCharacterError` if the string were handed to it directly. Encoding to
 * UTF-8 bytes first and mapping each byte to a code unit is what makes the codec
 * safe for any name an author can type. The `+/=` alphabet is then swapped for
 * `-_` and the padding dropped, so a code survives being pasted into a URL.
 */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** base64url → UTF-8, or `null` for anything that is not both. */
function fromBase64Url(payload: string): string | null {
  try {
    const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    // `fatal` matters: without it a corrupted byte becomes U+FFFD and the JSON
    // parse below fails with a message about a character nobody typed.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// --- Export ----------------------------------------------------------------
// ---------------------------------------------------------------------------

/** `BC1.<base64url(minified JSON)>`. */
export function encodeShare(level: LevelData): string {
  return `${SHARE_PREFIX}.${toBase64Url(JSON.stringify(level))}`;
}

/** The file a download writes: pretty, newline-terminated, diffable. */
export function exportJson(level: LevelData): string {
  return `${JSON.stringify(level, null, 2)}\n`;
}

/**
 * A file name from a stage name.
 *
 * Lower-cased, non-alphanumerics folded to hyphens, capped at 48 characters —
 * a stage called `../../etc/passwd` or one with 200 characters of emoji has to
 * produce something a file system will accept.
 */
export function shareFileName(level: LevelData): string {
  const slug = level.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return `${slug === '' ? 'custom-stage' : slug}.json`;
}

// ---------------------------------------------------------------------------
// --- Import ----------------------------------------------------------------
// ---------------------------------------------------------------------------

/** Decode a `BC1.` share code. */
export function decodeShare(text: string): ImportResult {
  const trimmed = text.trim();
  const tagged = TAGGED.exec(trimmed);
  if (tagged === null) {
    return fail(
      `A share code starts with "${SHARE_PREFIX}." — this text does not.`,
    );
  }
  const [, tag, payload] = tagged;
  if (tag !== SHARE_PREFIX) {
    return fail(
      `Share code version "${tag}" is not supported. This build reads ` +
        `"${SHARE_PREFIX}." codes.`,
    );
  }
  const json = fromBase64Url(payload);
  if (json === null) {
    return fail(
      'The share code is damaged: the part after the prefix is not valid ' +
        'base64url text. Copy the whole code and try again.',
    );
  }
  return fromJson(json);
}

/**
 * Import a paste: a share code, or the contents of an exported JSON file.
 *
 * The fork is the first non-whitespace character. A JSON object starts with
 * `{`; nothing else does, and a share code most certainly does not.
 */
export function importText(text: string): ImportResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return fail('There is nothing to import — paste a share code or a level.');
  }
  return trimmed.startsWith('{') ? fromJson(trimmed) : decodeShare(trimmed);
}

function fromJson(json: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    return fail(
      `That is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // From here the answer is the validator's, word for word (arch §9).
  const result = validateLevel(parsed);
  return result.ok ? { ok: true, level: result.level } : fail(...result.errors);
}
