import type { ParsedEmailMessage } from './types';

/** Input cap to guard against ReDoS on pathological inputs. */
const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Decode a quoted-printable string per RFC 2045:
 * - Soft line breaks `=\r\n` and `=\n` are removed (line-continuation).
 * - `=XX` hex sequences are decoded to the corresponding byte.
 * - CRLF is normalised to LF.
 */
export function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r\n/g, '')
    .replace(/=\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\r\n/g, '\n');
}

/** Decode a base64 body (stripping whitespace first). */
function decodeBase64Part(input: string): string {
  try {
    return Buffer.from(input.replace(/\s/g, ''), 'base64').toString('utf-8');
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

function decodePart(body: string, encoding: string): string {
  const enc = encoding.toLowerCase().trim();
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  if (enc === 'base64') return decodeBase64Part(body);
  return body;
}

/**
 * Parse a raw RFC 822 email (as bytes) into a {@link ParsedEmailMessage}.
 *
 * `messageId` is the Gmail message id from `RawInput.filename` — it is NOT
 * extracted from the email headers (ADR-004 / shared-contract §1).
 */
export function parseMimeMessage(bytes: Uint8Array, messageId: string): ParsedEmailMessage {
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
        const decoded = decodePart(partBody, enc);

        // Recursively handle multipart/related or multipart/mixed nested inside
        if (/multipart\//i.test(partCt)) {
          const nested = parseMimeMessage(
            new TextEncoder().encode(part),
            messageId,
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
    html = decodePart(body, enc);
  } else {
    const enc = headers['content-transfer-encoding'] ?? '';
    text = decodePart(body, enc);
  }

  return { from, subject, html, text, messageId };
}

/**
 * Minimal RFC 2047 encoded-word decoder for Subject / From headers.
 * Handles `=?charset?Q?...?=` (quoted-printable) and `=?charset?B?...?=` (base64).
 */
function decodeRfc2047(header: string): string {
  return header.replace(
    /=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g,
    (_full, _charset: string, encoding: string, text: string) => {
      const enc = encoding.toUpperCase();
      if (enc === 'Q') {
        return decodeQuotedPrintable(text.replace(/_/g, ' '));
      }
      if (enc === 'B') {
        try {
          return Buffer.from(text, 'base64').toString('utf-8');
        } catch {
          return text;
        }
      }
      return text;
    },
  );
}
