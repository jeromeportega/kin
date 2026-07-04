import 'server-only';

import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

/**
 * True when Plaid credentials are present. Drives the connect-on-first-access UI
 * and lets the routes 503 cleanly (rather than throw) when Plaid isn't wired up.
 */
export function plaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

/** `sandbox` (default) or `production`. Plaid retired the standalone development env. */
function plaidBasePath(): string {
  return process.env.PLAID_ENV === 'production'
    ? PlaidEnvironments.production
    : PlaidEnvironments.sandbox;
}

/** A configured Plaid API client. Throws if credentials are missing — callers
 *  should gate on {@link plaidConfigured} first. */
export function plaidClient(): PlaidApi {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error('Plaid is not configured — set PLAID_CLIENT_ID and PLAID_SECRET');
  }
  return new PlaidApi(
    new Configuration({
      basePath: plaidBasePath(),
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': clientId,
          'PLAID-SECRET': secret,
          'Plaid-Version': '2020-09-14',
        },
      },
    }),
  );
}
