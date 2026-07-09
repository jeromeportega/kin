import type { NormalizedOrder } from '../../../model/normalized';
import type { ParsedEmailMessage, RetailerEmailParser } from '../types';
import { buildTabularOrder, extractFromAddress, isShipmentNotice } from '../order-table';

/**
 * Target order-confirmation / refund email parser. Reuses the shared tabular
 * order pipeline (extraction + summary denylist + reconciliation/negative guards
 * + message-scoped shipmentId + shipment-notice rejection); only the identity +
 * order-id shape are Target-specific.
 *
 * NOTE: the Target-specific patterns are best-effort against Target's known email
 * format and should be validated against real Target order emails. The shared
 * pipeline is fail-closed — a mis-parse throws → the adapter skips it with an
 * ImportError, never persisting wrong data — so an inaccurate pattern degrades to
 * "receipt not imported," not to corrupt finance data.
 */

// Target order mail is sent from target.com (often the oe.target.com subdomain).
const TARGET_DOMAIN_RE = /^[\w.+\-]+@([\w\-]+\.)?target\.com$/i;

// Target order numbers: a long all-numeric id (e.g. 3001234567890) or a
// hyphenated ref. ANCHORED to the "Order #/number/:" label so a tracking or
// other long digit-string can't be mistaken for the order id.
const TARGET_ORDER_ID_RE = /order\s*(?:#|number)?\s*:?\s*(\d{10,17}|\d{3,4}-\d{7,10})\b/i;

export const targetEmailParser: RetailerEmailParser = {
  retailer: 'target',
  gmailQuery:
    'from:(orders@oe.target.com OR orders@target.com OR no-reply@target.com OR noreply@target.com OR TargetNews@target.com) subject:(order OR receipt OR refund OR return) -subject:(shipped OR shipping OR delivered OR tracking OR "out for delivery" OR "on its way" OR "drive up")',

  matches(msg: ParsedEmailMessage): boolean {
    // Target sends order confirmations AND shipment/drive-up notices from the same
    // addresses — reject shipment notices (shared guard) so they don't double-book.
    if (!TARGET_DOMAIN_RE.test(extractFromAddress(msg.from))) return false;
    if (isShipmentNotice(msg.subject)) return false;
    return true;
  },

  parse(msg: ParsedEmailMessage): NormalizedOrder {
    return buildTabularOrder(msg, {
      retailer: 'target',
      label: 'Target email',
      orderIdRe: TARGET_ORDER_ID_RE,
    });
  },
};
