import { describe, expect, it } from 'vitest';
import type { Transaction } from 'plaid';

import { plaidTransactionToNormalized } from './map';

// Minimal Plaid transaction — only the fields the mapper reads. Cast keeps the
// fixture readable without spelling out the full (large) Transaction type.
function txn(over: Partial<Transaction>): Transaction {
  return {
    transaction_id: 't1',
    account_id: 'a1',
    amount: 49.99,
    date: '2025-01-20',
    name: 'BEST BUY #123',
    merchant_name: 'Best Buy',
    pending: false,
    ...over,
  } as unknown as Transaction;
}

describe('plaidTransactionToNormalized', () => {
  it("inverts Plaid's sign: a purchase (positive) becomes a negative debit", () => {
    const n = plaidTransactionToNormalized(txn({ amount: 49.99 }));
    expect(n.amountCents).toBe(-4999);
    expect(n.direction).toBe('debit');
  });

  it('maps a refund (negative in Plaid) to a positive credit', () => {
    const n = plaidTransactionToNormalized(txn({ amount: -16 }));
    expect(n.amountCents).toBe(1600);
    expect(n.direction).toBe('credit');
  });

  it('normalizes merchant_name like the CSV bank path and keeps the raw name', () => {
    const n = plaidTransactionToNormalized(txn({ merchant_name: 'Best Buy', name: 'BEST BUY #123' }));
    expect(n.normalizedMerchant).toBe('BEST BUY');
    expect(n.rawMerchant).toBe('BEST BUY #123');
  });

  it('falls back to name when merchant_name is null', () => {
    const n = plaidTransactionToNormalized(txn({ merchant_name: null, name: 'WHOLE FOODS' }));
    expect(n.normalizedMerchant).toBe('WHOLE FOODS');
  });

  it('keys sourceRowHash off the stable transaction_id so re-syncs dedup', () => {
    const a = plaidTransactionToNormalized(txn({ transaction_id: 'abc' }));
    const again = plaidTransactionToNormalized(txn({ transaction_id: 'abc' }));
    expect(a.sourceRowHash).toBe(again.sourceRowHash);
    const other = plaidTransactionToNormalized(txn({ transaction_id: 'xyz' }));
    expect(other.sourceRowHash).not.toBe(a.sourceRowHash);
  });
});
