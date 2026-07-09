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
function htmlEmail(subject: string, body: string, from = 'orders@oe.target.com', messageId = 'tgt-inline'): RawInput {
  const raw = [`From: ${from}`, `Subject: ${subject}`, 'Content-Type: text/html; charset=utf-8', '', body].join(
    '\r\n',
  );
  return { kind: 'eml', filename: messageId, bytes: new TextEncoder().encode(raw) };
}

describe('target parser — order confirmation', () => {
  function getOrder() {
    const batch = normalizeSync(emlInput('target-order.eml', 'tgt-msg-1'));
    expect(batch.errors).toEqual([]);
    expect(batch.orders).toHaveLength(1);
    return batch.orders[0]!;
  }

  it('supports() recognizes an oe.target.com sender', () => {
    expect(emlAdapter.supports(emlInput('target-order.eml'))).toBe(true);
  });

  it('captures ONLY the two real items (summary rows rejected) with source=target', () => {
    const order = getOrder();
    expect(order.source).toBe('target');
    expect(order.externalOrderId).toBe('3001234567890');
    expect(order.orderDate).toBe('2026-01-15');
    expect(order.items).toHaveLength(2);
    expect(order.items.map((i) => i.description).sort()).toEqual([
      'Good & Gather Milk, 1 gal',
      'Market Pantry Eggs, dozen',
    ]);
  });

  it('line items reconcile to the subtotal ($6.48); orderTotal is the grand total', () => {
    const order = getOrder();
    expect(order.items.reduce((s, i) => s + i.amountCents, 0)).toBe(648);
    expect(order.orderTotalCents).toBe(693);
  });
});

describe('target parser — refund', () => {
  it('books only the negative return line', () => {
    const batch = normalizeSync(emlInput('target-return.eml', 'tgt-refund-1'));
    expect(batch.orders).toHaveLength(1);
    const items = batch.orders[0]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.isReturn).toBe(true);
    expect(items[0]!.amountCents).toBe(-349);
    expect(items[0]!.refundDestination).toBe('card');
  });
});

describe('target parser — hardening', () => {
  it('does NOT claim a shipment/drive-up notice', () => {
    const batch = normalizeSync(
      htmlEmail(
        'Your Target order is ready for Drive Up',
        `<p>Order# 3001234567890</p><p>Order date: January 15, 2026</p>
         <table><tr><td>Good &amp; Gather Milk</td><td>$3.49</td></tr></table>`,
        'orders@oe.target.com',
        'tgt-driveup-1',
      ),
    );
    expect(batch.orders).toHaveLength(0);
    expect(batch.errors[0]!.reason).toMatch(/no retailer parser/i);
  });

  it('anchors the order id — a tracking number does not hijack it', () => {
    const batch = normalizeSync(
      htmlEmail(
        'Your Target order confirmation',
        `<p>Tracking 9400123456789012345678</p><p>Order# 3001234567890</p>
         <p>Order date: January 15, 2026</p>
         <table>
           <tr><td>Good &amp; Gather Milk</td><td>$3.49</td></tr>
           <tr><td>Subtotal</td><td>$3.49</td></tr>
         </table>
         <p>Subtotal: $3.49</p>`,
        'orders@oe.target.com',
        'tgt-track-1',
      ),
    );
    expect(batch.orders).toHaveLength(1);
    expect(batch.orders[0]!.externalOrderId).toBe('3001234567890');
  });
});

describe('dispatch seam routes three retailers', () => {
  const msg = (name: string) => parseMimeMessage(loadFixture(name), `d-${name}`);
  it('routes target / walmart / amazon emails to their own parsers', () => {
    expect(matchParser(msg('target-order.eml'))?.retailer).toBe('target');
    expect(matchParser(msg('walmart-order.eml'))?.retailer).toBe('walmart');
    expect(matchParser(msg('amazon-order.eml'))?.retailer).toBe('amazon');
  });
  it('the composed Gmail query covers all three retailers', () => {
    const q = emlGmailQuery();
    expect(q).toContain('amazon.com');
    expect(q).toContain('walmart.com');
    expect(q).toContain('target.com');
  });
});
