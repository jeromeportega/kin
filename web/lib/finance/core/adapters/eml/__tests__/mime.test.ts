import { describe, expect, it } from 'vitest';
import { decodeQuotedPrintable, splitMultipartParts, parseMimeMessage } from '../mime';

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
