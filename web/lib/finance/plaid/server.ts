import 'server-only';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { CountryCode, Products } from 'plaid';

import type { HouseholdScope } from '../core/scope';
import { createDb, type FinanceDb } from '../db/client';
import { plaidItems } from '../db/schema';
import { reconcileHousehold } from '../server';
import { plaidClient } from './client';
import { syncItem } from './sync';

// Plaid's server entry points for kin's web layer. Each is household-scoped; the
// access token never leaves this module (routes only ever see counts / booleans).

let _db: FinanceDb | undefined;
function db(): FinanceDb {
  return (_db ??= createDb());
}

/**
 * Create a Link token for this household's user. `redirect_uri` is only sent
 * when PLAID_REDIRECT_URI is set (required for OAuth banks, which must have the
 * URI pre-registered in the Plaid dashboard); sandbox test institutions omit it.
 */
export async function createLinkToken(scope: HouseholdScope): Promise<string> {
  const redirectUri = process.env.PLAID_REDIRECT_URI;
  const res = await plaidClient().linkTokenCreate({
    user: { client_user_id: scope.householdId },
    client_name: 'kin',
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: 'en',
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
  });
  return res.data.link_token;
}

/**
 * Exchange the Link `public_token` for a durable access token, store the Item,
 * then run an initial sync + reconcile so the review queue is populated the
 * moment a bank connects. Re-linking the same Item is a no-op (unique item_id).
 */
export async function exchangeAndSync(
  scope: HouseholdScope,
  publicToken: string,
  institution?: { id?: string; name?: string },
): Promise<{ added: number; skippedDuplicates: number }> {
  const api = plaidClient();
  const exchange = await api.itemPublicTokenExchange({ public_token: publicToken });

  await db()
    .insert(plaidItems)
    .values({
      id: randomUUID(),
      householdId: scope.householdId,
      itemId: exchange.data.item_id,
      accessToken: exchange.data.access_token,
      institutionId: institution?.id ?? null,
      institutionName: institution?.name ?? null,
    })
    .onConflictDoNothing();

  return syncHousehold(scope);
}

/** Sync every connected Item for the household, then reconcile once. */
export async function syncHousehold(
  scope: HouseholdScope,
): Promise<{ added: number; skippedDuplicates: number }> {
  const api = plaidClient();
  const items = await db()
    .select()
    .from(plaidItems)
    .where(eq(plaidItems.householdId, scope.householdId));

  let added = 0;
  let skippedDuplicates = 0;
  for (const item of items) {
    const out = await syncItem(db(), api, item);
    added += out.added;
    skippedDuplicates += out.skippedDuplicates;
  }
  if (items.length > 0) await reconcileHousehold(scope);
  return { added, skippedDuplicates };
}

/** Whether the household already has a linked bank — drives connect-on-first-access. */
export async function hasPlaidItem(scope: HouseholdScope): Promise<boolean> {
  const rows = await db()
    .select({ id: plaidItems.id })
    .from(plaidItems)
    .where(eq(plaidItems.householdId, scope.householdId))
    .limit(1);
  return rows.length > 0;
}
