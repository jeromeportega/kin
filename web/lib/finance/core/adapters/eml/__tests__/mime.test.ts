import { describe, expect, it } from 'vitest';
import { decodeQuotedPrintable, splitMultipartParts, parseMimeMessage, decodeRfc2047 } from '../mime';

describe('decodeQuotedPrintable', () => {
  it('removes soft line breaks (=CRLF)', () => {
    expect(decodeQuotedPrintable('hello=\r\nworld')).toBe('helloworld');
  });

  it('removes soft line breaks (=LF)', () => {
    expect(decodeQuotedPrintable('hello=\nworld')).toBe('helloworld');
  });

  it('decodes hex escape =3D to =', () => {
    expect(decodeQuotedPrintable('price=3D$5.00')).toBe('price=$5.00');
  });

  it('decodes =20 to space', () => {
    expect(decodeQuotedPrintable('hello=20world')).toBe('hello world');
  });

  it('decodes mixed: soft break + hex escape', () => {
    const input = 'USB=2DC=\r\nCable';
    expect(decodeQuotedPrintable(input)).toBe('USB-CCable');
  });

  it('normalises CRLF to LF', () => {
    expect(decodeQuotedPrintable('line1\r\nline2')).toBe('line1\nline2');
  });

  it('is a no-op for plain ASCII with no special sequences', () => {
    const plain = 'Hello, World!';
    expect(decodeQuotedPrintable(plain)).toBe(plain);
  });
});

describe('splitMultipartParts', () => {
  const boundary = '==BOUND==';

  it('returns an empty array when no delimiter is found', () => {
    expect(splitMultipartParts('no delimiter here', boundary)).toEqual([]);
  });

  it('splits two parts correctly', () => {
    const body = [
      '--==BOUND==',
      'Content-Type: text/plain',
      '',
      'part one',
      '--==BOUND==',
      'Content-Type: text/html',
      '',
      '<p>part two</p>',
      '--==BOUND==--',
    ].join('\n');

    const parts = splitMultipartParts(body, boundary);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('part one');
    expect(parts[1]).toContain('part two');
  });

  it('handles CRLF line endings', () => {
    const body =
      '--==BOUND==\r\nContent-Type: text/plain\r\n\r\nhello\r\n--==BOUND==--\r\n';
    const parts = splitMultipartParts(body, boundary);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain('hello');
  });

  it('caps input at MAX_INPUT_BYTES to prevent ReDoS', () => {
    // 6 MB > MAX_INPUT_BYTES (5 MB) — should not throw or hang
    const oversized = '--==BOUND==\n' + 'x'.repeat(6 * 1024 * 1024) + '\n--==BOUND==--\n';
    expect(() => splitMultipartParts(oversized, boundary)).not.toThrow();
  });
});

describe('parseMimeMessage', () => {
  function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  }

  it('parses a plain text email', () => {
    const raw = [
      'From: sender@example.com',
      'Subject: Hello',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Body text here',
    ].join('\r\n');

    const msg = parseMimeMessage(encode(raw), 'msg-id-123');
    expect(msg.from).toBe('sender@example.com');
    expect(msg.subject).toBe('Hello');
    expect(msg.messageId).toBe('msg-id-123');
    expect(msg.text).toContain('Body text here');
    expect(msg.html).toBe('');
  });

  it('parses a multipart/alternative email and extracts both html and text parts', () => {
    const raw = [
      'From: test@example.com',
      'Subject: Multipart Test',
      'Content-Type: multipart/alternative; boundary="===BOUND==="',
      '',
      '--===BOUND===',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plain text part',
      '--===BOUND===',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML part</p>',
      '--===BOUND===--',
    ].join('\r\n');

    const msg = parseMimeMessage(encode(raw), 'msg-id-456');
    expect(msg.text).toContain('Plain text part');
    expect(msg.html).toContain('HTML part');
  });

  it('decodes quoted-printable in a part', () => {
    const raw = [
      'From: test@example.com',
      'Subject: QP Test',
      'Content-Type: multipart/alternative; boundary="B"',
      '',
      '--B',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'USB=2DC Cable=\r\nhas arrived',
      '--B--',
    ].join('\r\n');

    const msg = parseMimeMessage(encode(raw), 'qp-msg');
    // =2D → -, soft break (=\r\n) removed; USB=2DC → USB-C; Cable=\r\nhas → Cablehas
    expect(msg.html).toContain('USB-C Cable');
    expect(msg.html).toContain('Cablehas arrived');
  });

  it('sets messageId from the provided parameter, not email headers', () => {
    const raw = [
      'From: sender@example.com',
      'Message-ID: <email-header-id@server.com>',
      'Content-Type: text/plain',
      '',
      'body',
    ].join('\r\n');

    const msg = parseMimeMessage(encode(raw), 'gmail-stable-id-789');
    expect(msg.messageId).toBe('gmail-stable-id-789');
  });
});

// ---------------------------------------------------------------------------
// decodeQuotedPrintable — multi-byte UTF-8
// ---------------------------------------------------------------------------

describe('decodeQuotedPrintable — multi-byte UTF-8', () => {
  it('decodes =C3=A9 (é, U+00E9) as a single character, not mojibake', () => {
    expect(decodeQuotedPrintable('caf=C3=A9')).toBe('café');
  });

  it('decodes a 3-byte sequence =E2=82=AC (€, U+20AC)', () => {
    expect(decodeQuotedPrintable('price: =E2=82=AC5')).toBe('price: €5');
  });

  it('decodes adjacent multi-byte sequences correctly', () => {
    // Two accented characters back-to-back: é (=C3=A9) ü (=C3=BC)
    expect(decodeQuotedPrintable('=C3=A9=C3=BC')).toBe('éü');
  });

  it('decodes multi-byte sequence split by soft line break correctly', () => {
    // Soft break between =C3 and =A9 must be handled: the two bytes end up adjacent
    // after soft-break removal, and the resulting [0xC3, 0xA9] decodes as é.
    expect(decodeQuotedPrintable('=C3=\r\n=A9')).toBe('é');
  });

  it('handles ASCII and multi-byte mixed content', () => {
    expect(decodeQuotedPrintable('Hello =C3=A9 world')).toBe('Hello é world');
  });
});

// ---------------------------------------------------------------------------
// decodeRfc2047 — charset support
// ---------------------------------------------------------------------------

describe('decodeRfc2047', () => {
  it('decodes UTF-8 Q-encoded header correctly', () => {
    // =?UTF-8?Q?caf=C3=A9?= → café
    expect(decodeRfc2047('=?UTF-8?Q?caf=C3=A9?=')).toBe('café');
  });

  it('decodes UTF-8 B-encoded (base64) header correctly', () => {
    // base64 of "café" in UTF-8
    const b64 = Buffer.from('café', 'utf-8').toString('base64');
    expect(decodeRfc2047(`=?UTF-8?B?${b64}?=`)).toBe('café');
  });

  it('decodes ISO-8859-1 Q-encoded header using the declared charset', () => {
    // In ISO-8859-1, 0xE9 = é.  =?ISO-8859-1?Q?caf=E9?= should yield "café".
    expect(decodeRfc2047('=?ISO-8859-1?Q?caf=E9?=')).toBe('café');
  });

  it('decodes ISO-8859-1 B-encoded header using the declared charset', () => {
    const b64 = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64'); // "café" as Latin-1
    expect(decodeRfc2047(`=?ISO-8859-1?B?${b64}?=`)).toBe('café');
  });

  it('decodes underscore as space in Q encoding', () => {
    expect(decodeRfc2047('=?UTF-8?Q?hello_world?=')).toBe('hello world');
  });

  it('falls back to UTF-8 for an unknown charset without throwing', () => {
    // Unknown charset — should not throw; fall back to UTF-8 best-effort.
    expect(() => decodeRfc2047('=?x-unknown-charset?Q?hello?=')).not.toThrow();
  });

  it('decodes mixed encoded-words and literal text', () => {
    const b64 = Buffer.from('café', 'utf-8').toString('base64');
    const result = decodeRfc2047(`Order for =?UTF-8?B?${b64}?= today`);
    expect(result).toBe('Order for café today');
  });

  it('case-insensitive encoding identifier (lowercase q and b)', () => {
    expect(decodeRfc2047('=?UTF-8?q?hello_world?=')).toBe('hello world');
    const b64 = Buffer.from('hi', 'utf-8').toString('base64');
    expect(decodeRfc2047(`=?UTF-8?b?${b64}?=`)).toBe('hi');
  });
});

// ---------------------------------------------------------------------------
// parseMimeMessage — recursion depth guard
// ---------------------------------------------------------------------------

describe('parseMimeMessage — recursion depth guard', () => {
  function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  }

  it('handles deeply nested multipart (depth > 5) without stack overflow', () => {
    // Build 7 levels of multipart/mixed nesting — exceeds the depth-5 guard.
    function nest(level: number, innerContent: string): string {
      if (level === 0) return innerContent;
      const b = `BOUND${level}`;
      return [
        `Content-Type: multipart/mixed; boundary="${b}"`,
        '',
        `--${b}`,
        nest(level - 1, innerContent),
        `--${b}--`,
      ].join('\r\n');
    }

    const deepBody = nest(7, 'Content-Type: text/plain\r\n\r\ndeep content');
    const raw = `From: test@example.com\r\nSubject: Deep\r\n${deepBody}`;

    // Must not throw (stack overflow)
    expect(() => parseMimeMessage(encode(raw), 'deep-id')).not.toThrow();
  });
});
