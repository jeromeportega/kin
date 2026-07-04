import type { ParsedEmailMessage } from './types';

/** Input cap to guard against ReDoS on pathological inputs. */
const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Decode a quoted-printable string per RFC 2045:
 * - Soft line breaks `=\r\n` and `=\n` are removed (line-continuation).
 * - `=XX` hex sequences are decoded to the corresponding byte.
 * - Consecutive =XX sequences are grouped into a Uint8Array and decoded via
 *   TextDecoder('utf-8') so multi-byte UTF-8 sequences (e.g. =C3=A9 → é)
 *   are handled correctly rather than producing per-byte mojibake.
 * - CRLF is normalised to LF.
 */
export function decodeQuotedPrintable(input: string): string {
  const stripped = input.replace(/=\r\n/g, '').replace(/=\n/g, '');

  // Group consecutive =XX runs into a Uint8Array and decode as UTF-8 together.
  const decoded = stripped.replace(/(=([0-9A-Fa-f]{2}))+/g, (match) => {
    const hexPairs = match.match(/=([0-9A-Fa-f]{2})/g)!;
    const bytes = new Uint8Array(hexPairs.map((h) => parseInt(h.slice(1), 16)));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  });

  return decoded.replace(/\r\n/g, '\n');
}

/** Decode a base64 body (stripping whitespace first). Uses the declared charset. */
function decodeBase64Part(input: string, charset = 'utf-8'): string {
  try {
    const bytes = new Uint8Array(Buffer.from(input.replace(/\s/g, ''), 'base64'));
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return input;
  }
}

function parseHeaderBlock(text: string): {
  headers: Record<string, string>;
  body: string;
} {
  const blankLine = /\r?\n\r?\n/.exec(text);
  if (!blankLine) return { headers: {}, body: text };

  const headerSection = text.slice(0, blankLine.index);
  const body = text.slice(blankLine.index + blankLine[0].length);

  // Unfold headers: continuation lines start with whitespace
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, ' ');

  const headers: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!(key in headers)) headers[key] = value;
  }

  return { headers, body };
}

function extractBoundary(contentType: string): string | null {
  const m = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * Split a MIME multipart body into its constituent part strings.
 * Exported for unit testing.
 */
export function splitMultipartParts(body: string, boundary: string): string[] {
  // ReDoS guard: cap before entering any loop/regex
  const safe = body.length > MAX_INPUT_BYTES ? body.slice(0, MAX_INPUT_BYTES) : body;

  const delimiter = '--' + boundary;
  const parts: string[] = [];
  const lines = safe.split(/\r?\n/);

  let collecting = false;
  let current: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === delimiter + '--') {
      if (collecting) {
        trimTrailingEmpty(current);
        if (current.length > 0) parts.push(current.join('\n'));
        current = []; // prevent after-loop double-push
      }
      break;
    }
    if (trimmed === delimiter) {
      if (collecting) {
        trimTrailingEmpty(current);
        if (current.length > 0) parts.push(current.join('\n'));
        current = [];
      }
      collecting = true;
      continue;
    }
    if (collecting) current.push(line);
  }

  if (collecting && current.length > 0) {
    trimTrailingEmpty(current);
    if (current.length > 0) parts.push(current.join('\n'));
  }

  return parts;
}

function trimTrailingEmpty(lines: string[]): void {
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
}

function extractCharset(contentType: string): string {
  const m = /charset=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType);
  return m ? (m[1] ?? m[2] ?? 'utf-8') : 'utf-8';
}

function decodePart(body: string, encoding: string, charset = 'utf-8'): string {
  const enc = encoding.toLowerCase().trim();
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  if (enc === 'base64') return decodeBase64Part(body, charset);
  return body;
}

/**
 * Parse a raw RFC 822 email (as bytes) into a {@link ParsedEmailMessage}.
 *
 * `messageId` is the Gmail message id from `RawInput.filename` — it is NOT
 * extracted from the email headers (ADR-004 / shared-contract §1).
 *
 * `depth` guards against stack exhaustion from deeply nested multipart/* structures;
 * recursion stops at depth 5 and nested parts beyond that are treated as opaque.
 */
export function parseMimeMessage(bytes: Uint8Array, messageId: string, depth = 0): ParsedEmailMessage {
  const rawBytes = bytes.length > MAX_INPUT_BYTES ? bytes.slice(0, MAX_INPUT_BYTES) : bytes;
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(rawBytes);

  const { headers, body } = parseHeaderBlock(raw);

  const from = headers['from'] ?? '';
  const subject = decodeRfc2047(headers['subject'] ?? '');
  const contentType = headers['content-type'] ?? '';

  let html = '';
  let text = '';

  if (/multipart\//i.test(contentType)) {
    const boundary = extractBoundary(contentType);
    if (boundary) {
      const parts = splitMultipartParts(body, boundary);
      for (const part of parts) {
        const { headers: partHeaders, body: partBody } = parseHeaderBlock(part);
        const partCt = partHeaders['content-type'] ?? '';
        const enc = partHeaders['content-transfer-encoding'] ?? '';
        const charset = extractCharset(partCt);
        const decoded = decodePart(partBody, enc, charset);

        // Recursively handle multipart/related or multipart/mixed nested inside.
        // Depth guard prevents stack exhaustion from pathologically nested emails.
        // Known limitation: for nested multipart with non-UTF-8 charsets, the
        // re-encode via TextEncoder (always UTF-8) locks in the initial lossy
        // conversion. This is acceptable for the Amazon use-case (UTF-8 only).
        if (/multipart\//i.test(partCt)) {
          if (depth >= 5) continue;
          const nested = parseMimeMessage(
            new TextEncoder().encode(part),
            messageId,
            depth + 1,
          );
          if (!html && nested.html) html = nested.html;
          if (!text && nested.text) text = nested.text;
        } else if (/text\/html/i.test(partCt)) {
          if (!html) html = decoded;
        } else if (/text\/plain/i.test(partCt)) {
          if (!text) text = decoded;
        }
      }
    }
  } else if (/text\/html/i.test(contentType)) {
    const enc = headers['content-transfer-encoding'] ?? '';
    const charset = extractCharset(contentType);
    html = decodePart(body, enc, charset);
  } else {
    const enc = headers['content-transfer-encoding'] ?? '';
    const charset = extractCharset(contentType);
    text = decodePart(body, enc, charset);
  }

  return { from, subject, html, text, messageId };
}

/**
 * Minimal RFC 2047 encoded-word decoder for Subject / From headers.
 * Handles `=?charset?Q?...?=` (quoted-printable) and `=?charset?B?...?=` (base64).
 * Uses the declared charset (e.g. ISO-8859-1, Windows-1252) for byte decoding
 * rather than always assuming UTF-8, preventing mojibake in older emails.
 * Exported for unit testing.
 */
export function decodeRfc2047(header: string): string {
  return header.replace(
    /=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g,
    (_full, charset: string, encoding: string, encodedText: string) => {
      const enc = encoding.toUpperCase();
      let bytes: Uint8Array;

      if (enc === 'Q') {
        // Q encoding: underscores are spaces; =XX are byte values in declared charset
        const unescaped = encodedText.replace(/_/g, ' ');
        const byteArr: number[] = [];
        let i = 0;
        while (i < unescaped.length) {
          if (
            unescaped[i] === '=' &&
            i + 2 < unescaped.length &&
            /[0-9A-Fa-f]{2}/.test(unescaped.slice(i + 1, i + 3))
          ) {
            byteArr.push(parseInt(unescaped.slice(i + 1, i + 3), 16));
            i += 3;
          } else {
            byteArr.push(unescaped.charCodeAt(i) & 0xff);
            i++;
          }
        }
        bytes = new Uint8Array(byteArr);
      } else if (enc === 'B') {
        try {
          bytes = new Uint8Array(Buffer.from(encodedText, 'base64'));
        } catch {
          return encodedText;
        }
      } else {
        return encodedText;
      }

      try {
        return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes);
      } catch {
        // Unknown charset — fall back to UTF-8
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      }
    },
  );
}
