/**
 * Integration test for the DB-backed reconcile source.
 *
 * Seeds a fresh file-based libSQL test DB via seedDemoHousehold (which inserts
 * the raw bank/order/receipt rows), then reads them back through
 * DrizzleReconcileSource.load and proves the reconstructed ReconcileInputs drive
 * the engine to the same matches — with the dedup invariant intact and strict
 * per-household scoping.
 *
 * Fully offline: no API key, no network, throwaway temp DB.
 */
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type FinanceDb } from '../../../db/client';
import { accounts, households, transactions } from '../../../db/schema';
import { DEMO_HOUSEHOLD_ID } from '../../scope';
import { DEMO_TXN_2_ID, DEMO_TXN_3_ID, seedDemoHousehold } from '../../seed/demoHousehold';
import { reconcile } from '../engine';
import { DrizzleReconcileSource } from '../source';

let db: FinanceDb;
let cleanup: () => void;

beforeEach(async () => {
  const handle = createTestDb();
  db = handle.db;
  cleanup = handle.cleanup;
  await seedDemoHousehold(db);
});

afterEach(() => cleanup());

describe('DrizzleReconcileSource.load — DB → ReconcileInputs', () => {
  it('loads the household corpus with signed bank amounts and nested items', async () => {
    const inputs = await new DrizzleReconcileSource(db).load(DEMO_HOUSEHOLD_ID);

    expect(inputs.householdId).toBe(DEMO_HOUSEHOLD_ID);
    expect(inputs.bankLines.length).toBeGreaterThan(0);
    expect(inputs.orders.length).toBeGreaterThan(0);
    expect(inputs.receipts.length).toBeGreaterThan(0);

    // Bank amounts load as stored — signed integer cents, debits negative.
    const txn2 = inputs.bankLines.find((b) => b.id === DEMO_TXN_2_ID);
    expect(txn2).toBeDefined();
    expect(txn2!.amountCents).toBe(-4999);
    expect(txn2!.direction).toBe('debit');
    expect(txn2!.normalizedMerchant).toBe('BEST BUY');

    // Orders and receipts carry their nested line items.
    expect(inputs.orders.every((o) => Array.isArray(o.items))).toBe(true);
    expect(inputs.orders.some((o) => o.items.length > 0)).toBe(true);
    expect(inputs.receipts.some((r) => r.items.length > 0)).toBe(true);
  });

  it('re-reconciling the loaded inputs reproduces the engine matches, dedup intact', async () => {
    const inputs = await new DrizzleReconcileSource(db).load(DEMO_HOUSEHOLD_ID);
    const ledger = reconcile(inputs);

    // The engine confirms a purchase link for the Best Buy debit (txn-demo-002) —
    // proving the reconstructed inputs are engine-faithful, not just well-typed.
    const matchedBankIds = new Set(
      ledger.matches.flatMap((m) => m.transactionIds ?? (m.transactionId ? [m.transactionId] : [])),
    );
    expect(matchedBankIds.has(DEMO_TXN_2_ID)).toBe(true);

    // Dedup invariant: no bank line is both auto-linked and unmatched.
    for (const id of ledger.unmatched.bankLines) {
      expect(matchedBankIds.has(id)).toBe(false);
    }

    // txn-demo-003 (Whole Foods) has no counterpart in the corpus → stays unmatched.
    expect(ledger.unmatched.bankLines).toContain(DEMO_TXN_3_ID);
  });

  it('scopes strictly to the household — a foreign account is never loaded', async () => {
    const foreignHousehold = randomUUID();
    const foreignAccount = randomUUID();
    const foreignTxn = randomUUID();
    await db.insert(households).values({ id: foreignHousehold, name: 'other' });
    await db
      .insert(accounts)
      .values({ id: foreignAccount, householdId: foreignHousehold, name: 'Other' });
    await db.insert(transactions).values({
      id: foreignTxn,
      accountId: foreignAccount,
      postedDate: '2025-03-01',
      amountCents: -9999,
      direction: 'debit',
      normalizedMerchant: 'FOREIGN CO',
      sourceRowHash: 'foreign-hash',
      dedupKey: 'foreign-dedup',
    });

    const inputs = await new DrizzleReconcileSource(db).load(DEMO_HOUSEHOLD_ID);
    expect(inputs.bankLines.some((b) => b.id === foreignTxn)).toBe(false);
  });
});
