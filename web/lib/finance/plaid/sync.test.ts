import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AccountBase, PlaidApi, Transaction } from 'plaid';

import { createTestDb, type FinanceDb } from '../db/client';
import { accounts, households, plaidItems, transactions } from '../db/schema';
import { syncItem, type PlaidItemRow, type PlaidSyncApi } from './sync';

const HH = 'hh-plaid-1';
const ROW = 'plaid-item-row-1';
const PLAID_ACCT = 'plaid-acct-1';

const acct = { account_id: PLAID_ACCT, name: 'Everyday Checking', type: 'depository', subtype: 'checking' } as unknown as AccountBase;

function tx(over: Partial<Transaction>): Transaction {
  return {
    transaction_id: 't1',
    account_id: PLAID_ACCT,
    amount: 49.99,
    date: '2025-01-20',
    name: 'BEST BUY',
    merchant_name: 'Best Buy',
    pending: false,
    ...over,
  } as unknown as Transaction;
}

// A one-page fake that returns the same corpus for any cursor — models an
// unchanged account, so a second sync exercises persistBatch's idempotency.
function fixedApi(added: Transaction[]): PlaidSyncApi {
  return {
    transactionsSync: (async () => ({
      data: {
        accounts: [acct],
        added,
        modified: [],
        removed: [],
        next_cursor: 'cursor-1',
        has_more: false,
        request_id: 'req',
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    })) as unknown as PlaidApi['transactionsSync'],
  };
}

let db: FinanceDb;
let cleanup: () => void;

beforeEach(async () => {
  const handle = createTestDb();
  db = handle.db;
  cleanup = handle.cleanup;
  await db.insert(households).values({ id: HH, name: 'test' });
  await db.insert(plaidItems).values({
    id: ROW,
    householdId: HH,
    itemId: 'plaid-item-ext-1',
    accessToken: 'access-sandbox-token',
    institutionName: 'Test Bank',
  });
});

afterEach(() => cleanup());

async function itemRow(): Promise<PlaidItemRow> {
  const [row] = await db.select().from(plaidItems).where(eq(plaidItems.id, ROW));
  return row;
}

describe('syncItem', () => {
  it('creates a kin account, lands posted transactions with inverted sign, skips pending', async () => {
    const posted = tx({ transaction_id: 'p1', amount: 49.99, pending: false });
    const pending = tx({ transaction_id: 'p2', amount: 12, pending: true });

    const out = await syncItem(db, fixedApi([posted, pending]), await itemRow());
    expect(out.accountsLinked).toBe(1);
    expect(out.added).toBe(1); // pending skipped

    const [account] = await db.select().from(accounts).where(eq(accounts.plaidItemId, ROW));
    expect(account.plaidAccountId).toBe(PLAID_ACCT);
    expect(account.institution).toBe('Test Bank');

    const rows = await db.select().from(transactions).where(eq(transactions.accountId, account.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCents).toBe(-4999); // Plaid +49.99 → kin −4999
    expect(rows[0].direction).toBe('debit');
    expect(rows[0].normalizedMerchant).toBe('BEST BUY');
  });

  it('advances the stored cursor after a successful sync', async () => {
    await syncItem(db, fixedApi([tx({ transaction_id: 'p1' })]), await itemRow());
    const [row] = await db.select().from(plaidItems).where(eq(plaidItems.id, ROW));
    expect(row.cursor).toBe('cursor-1');
  });

  it('is idempotent: re-syncing the same corpus inserts nothing new', async () => {
    const corpus = [tx({ transaction_id: 'p1' }), tx({ transaction_id: 'p2', amount: 8.5 })];
    const first = await syncItem(db, fixedApi(corpus), await itemRow());
    expect(first.added).toBe(2);

    const second = await syncItem(db, fixedApi(corpus), await itemRow());
    expect(second.added).toBe(0);
    expect(second.skippedDuplicates).toBe(2);

    const [account] = await db.select().from(accounts).where(eq(accounts.plaidItemId, ROW));
    const rows = await db.select().from(transactions).where(eq(transactions.accountId, account.id));
    expect(rows).toHaveLength(2); // no duplicate account, no duplicate rows
  });

  it('drains multiple pages until has_more is false', async () => {
    const pagedApi: PlaidSyncApi = {
      transactionsSync: (async (req: { cursor?: string }) => ({
        data: req.cursor
          ? {
              accounts: [acct],
              added: [tx({ transaction_id: 'pg2', amount: 20 })],
              modified: [],
              removed: [],
              next_cursor: 'c2',
              has_more: false,
              request_id: 'r2',
              transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
            }
          : {
              accounts: [acct],
              added: [tx({ transaction_id: 'pg1', amount: 10 })],
              modified: [],
              removed: [],
              next_cursor: 'c1',
              has_more: true,
              request_id: 'r1',
              transactions_update_status: 'HISTORICAL_UPDATE_IN_PROGRESS',
            },
      })) as unknown as PlaidApi['transactionsSync'],
    };

    const out = await syncItem(db, pagedApi, await itemRow());
    expect(out.added).toBe(2);
    const [row] = await db.select().from(plaidItems).where(eq(plaidItems.id, ROW));
    expect(row.cursor).toBe('c2');
  });
});
