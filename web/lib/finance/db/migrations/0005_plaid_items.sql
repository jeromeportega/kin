-- Plaid connectivity: one row per linked institution (Item), plus the columns
-- that tie a kin account back to the Plaid account it mirrors.
--
-- SECURITY: access_token is stored as plaintext, matching the existing
-- gmail_tokens posture (see lib/tokenStore.ts TODO(sec)). A Plaid access_token
-- grants ongoing read access to the linked account's transactions. Encrypt at
-- rest (AES-256-GCM with an env-/KMS-backed key) before any broad deployment.
CREATE TABLE plaid_items (
  id text PRIMARY KEY NOT NULL,
  household_id text NOT NULL REFERENCES households(id),
  item_id text NOT NULL,
  access_token text NOT NULL,
  institution_id text,
  institution_name text,
  cursor text,
  status text NOT NULL DEFAULT 'active',
  created_at text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX ux_plaid_items_item_id ON plaid_items(item_id);

-- Link accounts to their Plaid origin. Both nullable so manual / CSV accounts
-- (plaid_account_id IS NULL) and Plaid-synced accounts coexist. The unique index
-- enforces one kin account per Plaid account (SQLite allows many NULLs).
ALTER TABLE accounts ADD COLUMN plaid_item_id text REFERENCES plaid_items(id);
ALTER TABLE accounts ADD COLUMN plaid_account_id text;
CREATE UNIQUE INDEX ux_accounts_plaid_account_id ON accounts(plaid_account_id);
