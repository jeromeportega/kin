import { describe, expect, it } from 'vitest';
import { stripHtml, innerText, extractTagBlocks } from '../html';

describe('stripHtml (linear)', () => {
  it('strips tags to spaces, decodes entities, collapses whitespace', () => {
    expect(stripHtml('<b>Widget</b> &amp; <i>Gadget</i>')).toBe('Widget & Gadget');
  });

  it('does not fuse text across adjacent tags', () => {
    expect(stripHtml('<span>a</span><span>b</span>')).toBe('a b');
  });

  it('keeps text inside nested tags', () => {
    expect(innerText('<td><b>Great Value</b> Milk</td>')).toBe('Great Value Milk');
  });

  it('drops an unterminated final tag safely', () => {
    expect(stripHtml('hello <not-closed')).toBe('hello');
  });

  it('is LINEAR — completes fast on a pathological run of "<" (old regex was ~polynomial)', () => {
    const start = Date.now();
    stripHtml('<'.repeat(300_000));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('extractTagBlocks', () => {
  it('extracts inner content and is name-exact (does not match <track> for tag "tr")', () => {
    expect(extractTagBlocks('<tr>a</tr><track>x</track><tr>b</tr>', 'tr')).toEqual(['a', 'b']);
  });

  it('returns [] on unclosed tags without hanging', () => {
    const start = Date.now();
    expect(extractTagBlocks('<tr>'.repeat(50_000), 'tr')).toEqual([]);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
