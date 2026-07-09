import type { NormalizedOrder } from '../../../model/normalized';
import type { ParsedEmailMessage, RetailerEmailParser } from '../types';
import { buildTabularOrder, extractFromAddress } from '../order-table';

/**
 * Match only the bare email address (not the display name) against amazon.com.
 * Prevents display-name spoofing ("Amazon.com Order" <phisher@evil.com>) and
 * subdomain-suffix attacks (noreply@amazon.com.evil.com).
 */
const AMAZON_DOMAIN_RE = /^[\w.+\-]+@([\w\-]+\.)?amazon\.com$/i;
const AMAZON_ORDER_ID_RE = /\b(\d{3}-\d{7}-\d{7})\b/;

export const amazonEmailParser: RetailerEmailParser = {
  retailer: 'amazon',
  // Only order confirmations + refunds — NOT shipment ("shipped"/ship-confirm)
  // emails, which this parser does not model (they'd be mis-scraped as partial
  // orders). Add them back when a shipment parser exists.
  gmailQuery:
    'from:(auto-confirm@amazon.com OR returns@amazon.com OR return@amazon.com) subject:(order OR refund OR return)',

  matches(msg: ParsedEmailMessage): boolean {
    return AMAZON_DOMAIN_RE.test(extractFromAddress(msg.from));
  },

  parse(msg: ParsedEmailMessage): NormalizedOrder {
    return buildTabularOrder(msg, {
      retailer: 'amazon',
      label: 'Amazon email',
      orderIdRe: AMAZON_ORDER_ID_RE,
    });
  },
};
