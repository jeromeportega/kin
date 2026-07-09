import type { NormalizedOrder } from '../../../model/normalized';
import type { ParsedEmailMessage, RetailerEmailParser } from '../types';
import { buildTabularOrder, extractFromAddress } from '../order-table';

/**
 * Walmart order-confirmation / refund email parser. Reuses the shared tabular
 * order pipeline (extraction + summary denylist + reconciliation/negative guards
 * + message-scoped shipmentId); only the identity + order-id shape are
 * Walmart-specific.
 *
 * NOTE: the Walmart-specific patterns below are best-effort against Walmart's
 * known email format and should be validated against real Walmart order emails.
 * Because the shared pipeline is fail-closed (a mis-parse throws → the adapter
 * skips it with an ImportError, never persisting wrong data), an inaccurate
 * pattern degrades to "receipt not imported", not to corrupt finance data.
 */

// Bare-address match against walmart.com (display-name / subdomain-suffix safe).
const WALMART_DOMAIN_RE = /^[\w.+\-]+@([\w\-]+\.)?walmart\.com$/i;

// Walmart order numbers: a hyphenated form (e.g. 2000123-45678901) or a long
// all-numeric id (e.g. 200012345678901).
const WALMART_ORDER_ID_RE = /\b(\d{7}-\d{7,8}|\d{13,17})\b/;

export const walmartEmailParser: RetailerEmailParser = {
  retailer: 'walmart',
  gmailQuery:
    'from:(help@walmart.com OR no-reply@walmart.com OR noreply@walmart.com OR orders@walmart.com) subject:(order OR receipt OR refund OR return)',

  matches(msg: ParsedEmailMessage): boolean {
    return WALMART_DOMAIN_RE.test(extractFromAddress(msg.from));
  },

  parse(msg: ParsedEmailMessage): NormalizedOrder {
    return buildTabularOrder(msg, {
      retailer: 'walmart',
      label: 'Walmart email',
      orderIdRe: WALMART_ORDER_ID_RE,
    });
  },
};
