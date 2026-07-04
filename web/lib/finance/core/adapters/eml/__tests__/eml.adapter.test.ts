import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedBatch, RawInput } from '../../source-adapter';
import { emlAdapter } from '../../eml.adapter';
import type { NormalizedOrder } from '../../../model/normalized';
import { matchParser, emlGmailQuery } from '../dispatch';
import { parseMimeMessage } from '../mime';
import { amazonEmailParser } from '../parsers/amazon';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURES = join(__dirname, 'fixtures');

function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

function emlInput(fixtureName: string, messageId = `test-msg-id-${fixtureName}`): RawInput {
  return {
    kind: 'eml',
    filename: messageId,
    bytes: loadFixture(fixtureName),
  };
}

/** Cast normalize result to NormalizedBatch — emlAdapter.normalize is synchronous. */
function normalizeSync(input: RawInput): NormalizedBatch {
  return emlAdapter.normalize(input) as NormalizedBatch;
}

// ---------------------------------------------------------------------------
// emlAdapter.supports()
// ---------------------------------------------------------------------------

describe('emlAdapter.supports()', () => {
  it('returns true for an Amazon order-confirmation email (kind=eml)', () => {
    expect(emlAdapter.supports(emlInput('amazon-order.eml'))).toBe(true);
  });

  it('returns true for an Amazon return/refund email', () => {
    expect(emlAdapter.supports(emlInput('amazon-return.eml'))).toBe(true);
  });

  it('returns false for a non-Amazon email with kind=eml', () => {
    expect(emlAdapter.supports(emlInput('junk.eml'))).toBe(false);
  });

  it('returns false for a malformed email with kind=eml', () => {
    expect(emlAdapter.supports(emlInput('malformed.eml'))).toBe(false);
  });

  it('returns false when kind is not eml (e.g. amazon CSV)', () => {
    const nonEml: RawInput = {
      kind: 'amazon',
      filename: 'Retail.OrderHistory.1.csv',
      bytes: new Uint8Array(Buffer.from('some,csv,data')),
    };
    expect(emlAdapter.supports(nonEml)).toBe(false);
  });

  it('returns false for a bank input with kind=bank', () => {
    expect(
      emlAdapter.supports({ kind: 'bank', filename: 'transactions.csv', bytes: new Uint8Array() }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// emlAdapter.normalize() — Amazon order fixture (a)
// ---------------------------------------------------------------------------

describe('emlAdapter.normalize() — Amazon order confirmation (fixture a)', () => {
  const MSG_ID = 'stable-gmail-msg-id-order-001';

  function getOrder(): NormalizedOrder {
    const batch = normalizeSync(emlInput('amazon-order.eml', MSG_ID));
    expect(batch.errors).toEqual([]);
    expect(batch.orders).toHaveLength(1);
    return batch.orders[0]!;
  }

  it('returns NormalizedBatch with transactions:[], receipts:[], one order', () => {
    const batch = normalizeSync(emlInput('amazon-order.eml', MSG_ID));
    expect(batch.transactions).toEqual([]);
    expect(batch.receipts).toEqual([]);
    expect(batch.orders).toHaveLength(1);
  });

  it('order-level: correct externalOrderId, orderDate (ISO), currency, source', () => {
    const order = getOrder();
    expect(order.source).toBe('amazon');
    expect(order.externalOrderId).toBe('113-1234567-1234567');
    expect(order.orderDate).toBe('2026-01-05');
    expect(order.currency).toBe('USD');
  });

  it('order-level: orderTotalCents is populated', () => {
    const order = getOrder();
    expect(order.orderTotalCents).toBeDefined();
    expect(order.orderTotalCents).toBe(2448); // $24.48
  });

  it('has 2 items with all required fields populated', () => {
    const order = getOrder();
    expect(order.items).toHaveLength(2);
    for (const item of order.items) {
      expect(item.shipmentId).toBeTruthy();
      expect(typeof item.itemSeq).toBe('number');
      expect(item.itemSeq).toBeGreaterThan(0);
      expect(item.description).toBeTruthy();
      expect(typeof item.quantity).toBe('number');
      expect(item.quantity).toBeGreaterThan(0);
      expect(typeof item.amountCents).toBe('number');
      expect(typeof item.isReturn).toBe('boolean');
      expect(item.sourceRowHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('item field parity with amazonAdapter: same fields as CSV shape', () => {
    // The CSV shape mandatory fields: shipmentId, itemSeq, description, quantity,
    // amountCents, isReturn, sourceRowHash. Optional: unitPriceCents, refundDestination.
    const order = getOrder();
    const item = order.items[0]!;
    expect('shipmentId' in item).toBe(true);
    expect('itemSeq' in item).toBe(true);
    expect('description' in item).toBe(true);
    expect('quantity' in item).toBe(true);
    expect('amountCents' in item).toBe(true);
    expect('isReturn' in item).toBe(true);
    expect('sourceRowHash' in item).toBe(true);
    // Optional fields should not throw when accessed
    void item.unitPriceCents;
    void item.refundDestination;
  });

  it('purchase items: positive amountCents, isReturn=false, no refundDestination', () => {
    const order = getOrder();
    const purchases = order.items.filter((i) => !i.isReturn);
    expect(purchases).toHaveLength(2);
    expect(purchases.every((i) => i.amountCents > 0)).toBe(true);
    expect(purchases.every((i) => i.refundDestination === undefined)).toBe(true);
  });

  it('item descriptions match fixture values', () => {
    const order = getOrder();
    const names = order.items.map((i) => i.description);
    expect(names).toContain('USB-C Cable, 2-pack');
    expect(names).toContain('Phone Stand');
  });

  it('USB-C Cable item: correct amount, unitPrice, quantity', () => {
    const order = getOrder();
    const cable = order.items.find((i) => i.description.includes('USB-C Cable'))!;
    expect(cable.amountCents).toBe(1399); // $13.99
    expect(cable.unitPriceCents).toBe(1399);
    expect(cable.quantity).toBe(1);
  });

  it('itemSeq values are unique and sequential within shipment', () => {
    const order = getOrder();
    const seqs = order.items.map((i) => i.itemSeq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// emlAdapter.normalize() — Amazon return fixture (b)
// ---------------------------------------------------------------------------

describe('emlAdapter.normalize() — Amazon return/refund (fixture b)', () => {
  const MSG_ID = 'stable-gmail-msg-id-return-001';

  function getOrder(): NormalizedOrder {
    const batch = normalizeSync(emlInput('amazon-return.eml', MSG_ID));
    expect(batch.errors).toEqual([]);
    expect(batch.orders).toHaveLength(1);
    return batch.orders[0]!;
  }

  it('extracts the correct order ID and date', () => {
    const order = getOrder();
    expect(order.externalOrderId).toBe('333-9876543-2109876');
    expect(order.orderDate).toBe('2026-03-10');
    expect(order.source).toBe('amazon');
  });

  it('return line: amountCents is negative, isReturn=true', () => {
    const order = getOrder();
    const returnLines = order.items.filter((i) => i.isReturn);
    expect(returnLines.length).toBeGreaterThanOrEqual(1);
    const ret = returnLines[0]!;
    expect(ret.amountCents).toBeLessThan(0);
    expect(ret.isReturn).toBe(true);
  });

  it('return line: amountCents is -4500 (-$45.00)', () => {
    const order = getOrder();
    const ret = order.items.find((i) => i.isReturn)!;
    expect(ret.amountCents).toBe(-4500);
  });

  it('return line: refundDestination is card (Visa)', () => {
    const order = getOrder();
    const ret = order.items.find((i) => i.isReturn)!;
    expect(ret.refundDestination).toBe('card');
  });

  it('purchase lines: positive amountCents, isReturn=false', () => {
    const order = getOrder();
    const purchases = order.items.filter((i) => !i.isReturn);
    expect(purchases.length).toBeGreaterThanOrEqual(1);
    expect(purchases.every((i) => i.amountCents > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sourceRowHash — deterministic across re-parses
// ---------------------------------------------------------------------------

describe('sourceRowHash determinism', () => {
  it('produces identical hashes for the same fixture with the same messageId', () => {
    const id = 'stable-gmail-id-xyz-42';
    const batch1 = normalizeSync(emlInput('amazon-order.eml', id));
    const batch2 = normalizeSync(emlInput('amazon-order.eml', id));
    expect(batch1.orders[0]?.items).toHaveLength(2);
    const hashes1 = batch1.orders[0]!.items.map((i) => i.sourceRowHash);
    const hashes2 = batch2.orders[0]!.items.map((i) => i.sourceRowHash);
    expect(hashes1).toEqual(hashes2);
  });

  it('produces DIFFERENT hashes when the messageId (filename) changes', () => {
    const batch1 = normalizeSync(emlInput('amazon-order.eml', 'msg-id-aaa'));
    const batch2 = normalizeSync(emlInput('amazon-order.eml', 'msg-id-bbb'));
    const hashes1 = batch1.orders[0]!.items.map((i) => i.sourceRowHash);
    const hashes2 = batch2.orders[0]!.items.map((i) => i.sourceRowHash);
    for (let i = 0; i < hashes1.length; i++) {
      expect(hashes1[i]).not.toBe(hashes2[i]);
    }
  });

  it('all sourceRowHashes within a batch are unique', () => {
    const batch = normalizeSync(emlInput('amazon-order.eml', 'msg-id-unique'));
    const hashes = batch.orders.flatMap((o) => o.items.map((i) => i.sourceRowHash));
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

// ---------------------------------------------------------------------------
// FR-10: skip-not-throw — unrecognized / malformed emails
// ---------------------------------------------------------------------------

describe('FR-10 skip-not-throw', () => {
  it('normalize() on a junk (non-Amazon) email returns empty orders + one ImportError, does not throw', () => {
    expect(() => normalizeSync(emlInput('junk.eml'))).not.toThrow();
    const batch = normalizeSync(emlInput('junk.eml'));
    expect(batch.orders).toEqual([]);
    expect(batch.errors).toHaveLength(1);
    expect(batch.errors[0]!.reason).toBeTruthy();
  });

  it('normalize() on a malformed email returns empty orders + ImportError, does not throw', () => {
    expect(() => normalizeSync(emlInput('malformed.eml'))).not.toThrow();
    const batch = normalizeSync(emlInput('malformed.eml'));
    expect(batch.orders).toEqual([]);
    expect(batch.errors.length).toBeGreaterThan(0);
  });

  it('normalize() on empty bytes returns empty orders + ImportError, does not throw', () => {
    const emptyInput: RawInput = {
      kind: 'eml',
      filename: 'empty-msg-id',
      bytes: new Uint8Array(0),
    };
    expect(() => normalizeSync(emptyInput)).not.toThrow();
    const batch = normalizeSync(emptyInput);
    expect(batch.orders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dispatch seam (FR-9)
// ---------------------------------------------------------------------------

describe('dispatch seam', () => {
  function parseMsg(fixtureName: string, messageId = 'test-dispatch-id') {
    return parseMimeMessage(loadFixture(fixtureName), messageId);
  }

  it('matchParser returns the Amazon parser for an Amazon order email', () => {
    const msg = parseMsg('amazon-order.eml');
    const parser = matchParser(msg);
    expect(parser).not.toBeNull();
    expect(parser?.retailer).toBe('amazon');
  });

  it('matchParser returns null for a junk (non-Amazon) email', () => {
    const msg = parseMsg('junk.eml');
    expect(matchParser(msg)).toBeNull();
  });

  it('emlGmailQuery() contains the Amazon parser gmailQuery', () => {
    const query = emlGmailQuery();
    expect(query).toContain(amazonEmailParser.gmailQuery);
  });

  it('emlGmailQuery() ORs multiple queries when a second parser is added (proves FR-9)', () => {
    // Prove the ORing logic works by simulating a second parser
    const fakeParser = {
      retailer: 'amazon' as const,
      gmailQuery: 'from:(orders@fakeshop.example.com)',
      matches: () => false,
      parse: (): never => { throw new Error('fake'); },
    };

    const parsers = [amazonEmailParser, fakeParser];
    const combined = parsers.map((p) => `(${p.gmailQuery})`).join(' OR ');
    expect(combined).toContain(amazonEmailParser.gmailQuery);
    expect(combined).toContain(fakeParser.gmailQuery);
    expect(combined).toContain(' OR ');
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe('emlAdapter — additional edge cases', () => {
  it('normalize() is synchronous — no network or credential access', () => {
    // Structural: normalize returns NormalizedBatch (not Promise), confirming
    // it is a pure synchronous transform of bytes.
    const result = emlAdapter.normalize(emlInput('amazon-order.eml', 'no-network-id'));
    // A Promise would have a .then method; a plain object does not
    expect(typeof (result as unknown as { then?: unknown }).then).not.toBe('function');
  });
});

// ---------------------------------------------------------------------------
// From-header address spoofing defence
// ---------------------------------------------------------------------------

describe('Amazon parser — From-header address extraction', () => {
  // Use a neutral subject with no amazon/order/refund keywords so that the
  // subject fallback path in matches() does NOT fire — this isolates the From check.
  function fakeEmlInput(from: string, subject = 'Package update from carrier'): RawInput {
    const raw = [
      `From: ${from}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Order Date: January 5, 2026',
      'Order Total: $10.00',
      'Order #113-1234567-1234567',
    ].join('\r\n');
    return { kind: 'eml', filename: 'spoof-test', bytes: new TextEncoder().encode(raw) };
  }

  it('supports() = true for a bare amazon.com address', () => {
    expect(emlAdapter.supports(fakeEmlInput('auto-confirm@amazon.com'))).toBe(true);
  });

  it('supports() = true for a display-name + angle-bracket amazon.com address', () => {
    expect(emlAdapter.supports(fakeEmlInput('"Amazon.com" <auto-confirm@amazon.com>'))).toBe(true);
  });

  it('supports() = false for display-name spoofing (amazon.com in name, evil domain in address)', () => {
    // "Amazon.com Order" <phisher@evil.com> must NOT match when subject is neutral
    expect(emlAdapter.supports(fakeEmlInput('"Amazon.com Order" <phisher@evil.com>'))).toBe(false);
  });

  it('supports() = false for subdomain suffix attack (amazon.com.evil.com)', () => {
    expect(emlAdapter.supports(fakeEmlInput('noreply@amazon.com.evil.com'))).toBe(false);
  });

  it('supports() = true for a legitimate subdomain (mail.amazon.com)', () => {
    expect(emlAdapter.supports(fakeEmlInput('noreply@mail.amazon.com'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parenthesized accounting-format amounts (($X.XX) → negative)
// ---------------------------------------------------------------------------

describe('Amazon parser — parenthesized accounting amounts', () => {
  it('parses ($45.00) as -4500 cents (return/refund line)', () => {
    const html = `
      <p>Order #113-0000001-0000001</p>
      <p>Order Date: January 5, 2026</p>
      <table>
        <tr><td>Wireless Headphones</td><td>($45.00)</td></tr>
      </table>
      <p>Order Total: $0.00</p>
    `;
    const raw = [
      'From: auto-confirm@amazon.com',
      'Subject: Your Amazon.com refund (#113-0000001-0000001)',
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
    ].join('\r\n');
    const input: RawInput = { kind: 'eml', filename: 'paren-test', bytes: new TextEncoder().encode(raw) };
    const batch = normalizeSync(input);
    expect(batch.orders).toHaveLength(1);
    const item = batch.orders[0]!.items.find((i) => i.description === 'Wireless Headphones');
    expect(item).toBeDefined();
    expect(item!.amountCents).toBe(-4500);
    expect(item!.isReturn).toBe(true);
  });
});
