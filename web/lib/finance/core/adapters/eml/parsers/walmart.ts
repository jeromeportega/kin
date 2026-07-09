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
// all-numeric id (e.g. 200012345678901). ANCHORED to the "Order #/:" label so a
// tracking number or other long digit-string in the email can't be mistaken for
// the order id (which would book items under a corrupt external identity).
const WALMART_ORDER_ID_RE = /order\s*#?\s*:?\s*(\d{7}-\d{7,8}|\d{13,17})\b/i;

// Walmart's shared sender (help@walmart.com) also sends shipment / delivery /
// pickup notices that RE-LIST the ordered items with no reconcilable subtotal.
// Booking those would double-count against the confirmation, and no parse guard
// can see it (the email is internally consistent) — so reject them by subject
// here (not only in the Gmail query, since .eml can arrive via other paths).
const WALMART_NON_ORDER_SUBJECT_RE =
  /shipp(ed|ing)|on (its|the) way|out for delivery|delivered|ready for (pickup|collection)|arriv|tracking/i;

export const walmartEmailParser: RetailerEmailParser = {
  retailer: 'walmart',
  gmailQuery:
    'from:(help@walmart.com OR no-reply@walmart.com OR noreply@walmart.com OR orders@walmart.com) subject:(order OR receipt OR refund OR return) -subject:(shipped OR shipping OR delivered OR tracking OR "out for delivery" OR "on its way")',

  matches(msg: ParsedEmailMessage): boolean {
    if (!WALMART_DOMAIN_RE.test(extractFromAddress(msg.from))) return false;
    if (WALMART_NON_ORDER_SUBJECT_RE.test(msg.subject)) return false;
    return true;
  },

  parse(msg: ParsedEmailMessage): NormalizedOrder {
    return buildTabularOrder(msg, {
      retailer: 'walmart',
      label: 'Walmart email',
      orderIdRe: WALMART_ORDER_ID_RE,
    });
  },
};
