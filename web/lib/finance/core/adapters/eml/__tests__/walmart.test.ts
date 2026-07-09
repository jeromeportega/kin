import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedBatch, RawInput } from '../../source-adapter';
import { emlAdapter } from '../../eml.adapter';
import { matchParser, emlGmailQuery } from '../dispatch';
import { parseMimeMessage } from '../mime';

const FIXTURES = join(__dirname, 'fixtures');
function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}
function emlInput(name: string, messageId = `test-${name}`): RawInput {
  return { kind: 'eml', filename: messageId, bytes: loadFixture(name) };
}
function normalizeSync(input: RawInput): NormalizedBatch {
  return emlAdapter.normalize(input) as NormalizedBatch;
}
function htmlEmail(subject: string, body: string, from = 'help@walmart.com', messageId = 'wmt-inline'): RawInput {
  const raw = [`From: ${from}`, `Subject: ${subject}`, 'Content-Type: text/html; charset=utf-8', '', body].join(
    '\r\n',
  );
  return { kind: 'eml', filename: messageId, bytes: new TextEncoder().encode(raw) };
}

describe('walmart parser — order confirmation', () => {
  function getOrder() {
    const batch = normalizeSync(emlInput('walmart-order.eml', 'wmt-msg-1'));
    expect(batch.errors).toEqual([]);
    expect(batch.orders).toHaveLength(1);
    return batch.orders[0]!;
  }

  it('supports() recognizes a walmart.com sender', () => {
    expect(emlAdapter.supports(emlInput('walmart-order.eml'))).toBe(true);
  });

  it('captures ONLY the two real items (summary rows rejected) with source=walmart', () => {
    const order = getOrder();
    expect(order.source).toBe('walmart');
    expect(order.externalOrderId).toBe('2000123-45678901');
    expect(order.orderDate).toBe('2026-01-10');
    expect(order.items).toHaveLength(2);
    expect(order.items.map((i) => i.description).sort()).toEqual([
      'Bananas, each',
      'Great Value Milk, 1 gal',
    ]);
  });

  it('line items reconcile to the subtotal ($4.72); orderTotal is the grand total', () => {
    const order = getOrder();
    expect(order.items.reduce((s, i) => s + i.amountCents, 0)).toBe(472);
    expect(order.orderTotalCents).toBe(510);
  });

  it('a quantity>1 line derives a unit price', () => {
    const bananas = getOrder().items.find((i) => i.description === 'Bananas, each')!;
    expect(bananas.quantity).toBe(2);
    expect(bananas.amountCents).toBe(148);
    expect(bananas.unitPriceCents).toBe(74);
  });

  it('shipmentId is scoped to the message id (shared dedup fix applies to walmart too)', () => {
    expect(getOrder().items[0]!.shipmentId).toContain('wmt-msg-1');
  });
});

describe('walmart parser — refund', () => {
  it('books only the negative return line, not the re-listed purchase', () => {
    const batch = normalizeSync(emlInput('walmart-return.eml', 'wmt-refund-1'));
    expect(batch.orders).toHaveLength(1);
    const items = batch.orders[0]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.isReturn).toBe(true);
    expect(items[0]!.amountCents).toBe(-324);
    expect(items[0]!.refundDestination).toBe('card');
  });
});

describe('dispatch seam routes by sender', () => {
  const msg = (name: string) => parseMimeMessage(loadFixture(name), `d-${name}`);

  it('a Walmart email → walmart parser; an Amazon email → amazon parser', () => {
    expect(matchParser(msg('walmart-order.eml'))?.retailer).toBe('walmart');
    expect(matchParser(msg('amazon-order.eml'))?.retailer).toBe('amazon');
  });

  it('the composed Gmail query covers both retailers', () => {
    const q = emlGmailQuery();
    expect(q).toContain('amazon.com');
    expect(q).toContain('walmart.com');
  });
});

describe('walmart parser — hardening (review fixes)', () => {
  it('does NOT claim a shipment/delivery notice (avoids double-booking re-listed items)', () => {
    const batch = normalizeSync(
      htmlEmail(
        'Great news — your order has shipped!',
        `<p>Order# 2000123-45678901</p><p>Order date: January 10, 2026</p>
         <table>
           <tr><td>Great Value Milk, 1 gal</td><td>$3.24</td></tr>
           <tr><td>Bananas, each</td><td>$1.48</td></tr>
         </table>`,
        'help@walmart.com',
        'wmt-ship-1',
      ),
    );
    expect(batch.orders).toHaveLength(0);
    expect(batch.errors).toHaveLength(1);
    expect(batch.errors[0]!.reason).toMatch(/no retailer parser/i);
  });

  it('anchors the order id to the Order# label — a tracking number does not hijack it', () => {
    const batch = normalizeSync(
      htmlEmail(
        'Your Walmart order confirmation',
        `<p>Tracking# 612909001234567</p><p>Order# 2000123-45678901</p>
         <p>Order date: January 10, 2026</p>
         <table>
           <tr><td>Great Value Milk, 1 gal</td><td>$3.24</td></tr>
           <tr><td>Subtotal</td><td>$3.24</td></tr>
         </table>
         <p>Subtotal: $3.24</p>`,
        'help@walmart.com',
        'wmt-track-1',
      ),
    );
    expect(batch.orders).toHaveLength(1);
    expect(batch.orders[0]!.externalOrderId).toBe('2000123-45678901');
  });

  it('parses a slash-format order date', () => {
    const batch = normalizeSync(
      htmlEmail(
        'Your Walmart order confirmation',
        `<p>Order# 2000123-45678901</p><p>Order date: 1/10/2026</p>
         <table>
           <tr><td>Great Value Milk, 1 gal</td><td>$3.24</td></tr>
           <tr><td>Subtotal</td><td>$3.24</td></tr>
         </table>
         <p>Subtotal: $3.24</p>`,
        'help@walmart.com',
        'wmt-slashdate-1',
      ),
    );
    expect(batch.orders).toHaveLength(1);
    expect(batch.orders[0]!.orderDate).toBe('2026-01-10');
  });
});
