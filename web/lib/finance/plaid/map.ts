import type { Transaction } from 'plaid';

import { cleanBankMerchant } from '../core/adapters/bank/merchant';
import { sha256Hex } from '../core/idempotency/keys';
import type { NormalizedTransaction } from '../core/model/normalized';

/**
 * Map one Plaid transaction to kin's NormalizedTransaction so Plaid data flows
 * through the exact same `persistBatch` path as a CSV upload.
 *
 * Sign inversion is the load-bearing detail: Plaid amounts are POSITIVE when
 * money leaves the account (a debit-card purchase) and NEGATIVE when it enters
 * (a refund or deposit). kin stores debits as negative signed cents, so we
 * negate. Get this wrong and every transaction's direction silently flips.
 *
 * `sourceRowHash` keys off Plaid's stable, globally-unique `transaction_id`, so
 * a posted transaction re-surfaced on a later cursor collapses to the same
 * `transactionDedupKey` and is skipped by persistBatch — idempotent re-syncs.
 *
 * Merchant text runs through the same `cleanBankMerchant` the CSV bank adapter
 * uses, so a Plaid "AMAZON" and a statement "AMZN Mktp US*RT4K9" normalize to
 * the same token the reconcile matchers compare.
 */
export function plaidTransactionToNormalized(txn: Transaction): NormalizedTransaction {
  const amountCents = Math.round(txn.amount * -100);
  const direction: 'debit' | 'credit' = txn.amount > 0 ? 'debit' : 'credit';
  const merchant = txn.merchant_name ?? txn.name ?? '';
  const normalizedMerchant = cleanBankMerchant(merchant) || 'UNKNOWN';
  return {
    postedDate: txn.date,
    amountCents,
    direction,
    rawMerchant: txn.name ?? undefined,
    normalizedMerchant,
    sourceRowHash: sha256Hex(`plaid:${txn.transaction_id}`),
  };
}
