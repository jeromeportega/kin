import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { AccountBase, PlaidApi, Transaction } from 'plaid';

import type { NormalizedBatch } from '../core/adapters/source-adapter';
import { persistBatch } from '../core/ingest/persist';
import type { FinanceDb } from '../db/client';
import { accounts, plaidItems } from '../db/schema';
import { plaidTransactionToNormalized } from './map';

/** The slice of PlaidApi that sync uses — lets tests pass a lightweight fake. */
export interface PlaidSyncApi {
  transactionsSync: PlaidApi['transactionsSync'];
}

/** The plaid_items columns sync reads (a subset of the row). */
export interface PlaidItemRow {
  id: string;
  householdId: string;
  accessToken: string;
  cursor: string | null;
  institutionName: string | null;
}

export interface SyncOutcome {
  itemId: string;
  added: number;
  skippedDuplicates: number;
  accountsLinked: number;
}

// A generous page cap: /transactions/sync drains via has_more; this only guards
// against a pathological non-terminating cursor, never a real backfill.
const MAX_PAGES = 100;

/**
 * Pull an Item's transaction deltas via /transactions/sync and land the POSTED
 * ones through the shared `persistBatch` path, then advance the stored cursor.
 *
 * Pending transactions are skipped: Plaid assigns a pending charge and its later
 * posted copy DIFFERENT transaction_ids, so persisting pending would double-count
 * once the posted copy arrives. kin reconciles on posted truth.
 *
 * `modified` deltas are re-persisted (idempotent for unchanged posted rows);
 * `removed` deltas are not yet applied — both need a `plaid_transaction_id`
 * upsert to handle fully, a documented follow-up. Posted transactions are
 * effectively immutable, so this is safe for the common case.
 */
export async function syncItem(
  db: FinanceDb,
  api: PlaidSyncApi,
  item: PlaidItemRow,
): Promise<SyncOutcome> {
  let cursor = item.cursor ?? undefined;
  const deltas: Transaction[] = [];
  const seenAccounts = new Map<string, AccountBase>();

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await api.transactionsSync({ access_token: item.accessToken, cursor });
    for (const a of res.data.accounts) seenAccounts.set(a.account_id, a);
    deltas.push(...res.data.added, ...res.data.modified);
    cursor = res.data.next_cursor;
    if (!res.data.has_more) break;
  }

  const accountIdByPlaid = await ensureAccounts(db, item, [...seenAccounts.values()]);

  // Group POSTED transactions by their kin account, then persist per account so
  // persistBatch's per-account dedup key applies.
  const byAccount = new Map<string, NormalizedBatch>();
  for (const txn of deltas) {
    if (txn.pending) continue;
    const accountId = accountIdByPlaid.get(txn.account_id);
    if (!accountId) continue;
    let batch = byAccount.get(accountId);
    if (!batch) {
      batch = { transactions: [], orders: [], receipts: [], errors: [] };
      byAccount.set(accountId, batch);
    }
    batch.transactions.push(plaidTransactionToNormalized(txn));
  }

  let added = 0;
  let skippedDuplicates = 0;
  for (const [accountId, batch] of byAccount) {
    const out = await persistBatch(db, batch, { householdId: item.householdId, accountId });
    added += out.inserted.transactions;
    skippedDuplicates += out.skippedDuplicates;
  }

  await db
    .update(plaidItems)
    .set({ cursor: cursor ?? null })
    .where(eq(plaidItems.id, item.id));

  return { itemId: item.id, added, skippedDuplicates, accountsLinked: accountIdByPlaid.size };
}

/**
 * Upsert one kin account per Plaid account, keyed by `plaid_account_id`. Returns
 * a Plaid-account-id → kin-account-id map covering every account seen. The
 * unique index on plaid_account_id keeps re-syncs from creating duplicates.
 */
async function ensureAccounts(
  db: FinanceDb,
  item: PlaidItemRow,
  plaidAccounts: AccountBase[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (plaidAccounts.length === 0) return map;

  const existing = await db
    .select({ id: accounts.id, plaidAccountId: accounts.plaidAccountId })
    .from(accounts)
    .where(eq(accounts.plaidItemId, item.id));
  for (const row of existing) if (row.plaidAccountId) map.set(row.plaidAccountId, row.id);

  for (const acct of plaidAccounts) {
    if (map.has(acct.account_id)) continue;
    const id = randomUUID();
    const type = acct.subtype ?? acct.type;
    await db
      .insert(accounts)
      .values({
        id,
        householdId: item.householdId,
        name: acct.name || acct.official_name || 'Account',
        type: type ? String(type) : null,
        institution: item.institutionName ?? null,
        plaidItemId: item.id,
        plaidAccountId: acct.account_id,
      })
      .onConflictDoNothing();
    map.set(acct.account_id, id);
  }
  return map;
}
