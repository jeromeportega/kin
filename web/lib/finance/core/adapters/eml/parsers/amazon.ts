import type { NormalizedOrder, NormalizedOrderItem, RefundDestination } from '../../../model/normalized';
import { sha256Hex } from '../../../idempotency/keys';
import { parseAmountToCents, toIsoDate } from '../../../normalize';
import type { ParsedEmailMessage, RetailerEmailParser } from '../types';

/** Cap HTML before regex to guard against ReDoS on malformed input. */
const MAX_HTML_BYTES = 2 * 1024 * 1024;

/**
 * Match only the bare email address (not the display name) against amazon.com.
 * Prevents display-name spoofing ("Amazon.com Order" <phisher@evil.com>) and
 * subdomain-suffix attacks (noreply@amazon.com.evil.com).
 */
const AMAZON_DOMAIN_RE = /^[\w.+\-]+@([\w\-]+\.)?amazon\.com$/i;
const AMAZON_ORDER_ID_RE = /\b(\d{3}-\d{7}-\d{7})\b/;

/**
 * Order-summary and payment rows render as `<tr>` with a price cell but are NOT
 * line items: Subtotal / Shipping / Tax / (Grand|Order) Total, and payment lines
 * like gift-card / promotion / store-credit applied. Capturing these inflates the
 * item set and — because summary payment lines are negative — mis-books them as
 * returns (accruing phantom store credit). Reject any row whose first cell is one
 * of these labels. Anchored at start so a product titled "Total Wireless …" or an
 * "Amazon eGift Card" purchase (name doesn't start with the payment phrasing) is
 * still kept; the reconciliation guard in `parse()` is the backstop.
 */
const SUMMARY_LABEL_RE =
  /^(sub[\s-]?total|item\(s\)\s+subtotal|shipping(\s*&(amp;)?\s*handling)?|handling|free\s+shipping|estimated\s+tax|sales\s+tax|tax|total\s+before\s+tax|order\s+total|grand\s+total|total|promotion(s)?(\s+applied)?|promo(tion)?\s+code|discount(s)?|coupon|savings|gift\s*card\s+(amount|balance|applied)|store\s+credit\s+(amount|balance|applied)|balance\s+applied|rewards?\s+(points?|applied)|import\s+fees?(\s+deposit)?)\b/i;

function isSummaryOrPaymentLabel(name: string): boolean {
  return SUMMARY_LABEL_RE.test(name.trim());
}

/** Extract the bare address-spec from a From header, stripping any display name. */
function extractFromAddress(from: string): string {
  const angleMatch = /<([^>]*)>/.exec(from);
  if (angleMatch?.[1]) return angleMatch[1].trim().toLowerCase();
  return from.trim().toLowerCase();
}

const FIELD_SEP = '\x00';

/** Strip HTML tags, decode common entities, and normalize whitespace. */
function stripHtml(html: string): string {
  const safe = html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
  return safe
    .replace(/<[^>]{0,5000}>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract text content from a single HTML tag's inner content. */
function innerText(fragment: string): string {
  return stripHtml(fragment).trim();
}

interface RawItem {
  name: string;
  quantity: number;
  amountCents: number;
  unitPriceCents?: number;
  isReturn: boolean;
  refundDestination?: RefundDestination;
}

/**
 * Parse items from an HTML table.
 *
 * Expects rows with ≥2 cells where the last cell matches a price pattern
 * ($X.XX or -$X.XX or ($X.XX) for returns).
 */
function parseItemsFromHtml(html: string): RawItem[] {
  const safe = html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
  const items: RawItem[] = [];

  // Match each <tr>...</tr> block
  const rowRe = /<tr[^>]{0,500}>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(safe)) !== null) {
    const rowContent = rowMatch[1]!;
    // Match all <td>...</td> blocks within this row
    const tdRe = /<td[^>]{0,500}>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRe.exec(rowContent)) !== null) {
      cells.push(innerText(tdMatch[1]!));
    }

    if (cells.length < 2) continue;

    const lastCell = cells[cells.length - 1]!;
    // Check if the last cell looks like a price: optional sign + $ + digits
    const priceMatch = /^(-?\s*\$[\d,]+\.\d{2}|\(\s*\$[\d,]+\.\d{2}\s*\))$/.exec(lastCell);
    if (!priceMatch) continue;

    // First cell is the item name
    const name = cells[0]!;
    if (!name || name.length === 0) continue;
    // Skip header rows
    if (/^(item|product|description|name)$/i.test(name)) continue;
    // Skip order-summary / payment rows (Subtotal, Tax, Shipping, Total, gift
    // card, promotion, …) — they are not line items.
    if (isSummaryOrPaymentLabel(name)) continue;

    // Try to parse quantity from any cell matching "Quantity: N" or "Qty: N" or just a number
    let quantity = 1;
    let unitPriceCents: number | undefined;

    for (let i = 1; i < cells.length - 1; i++) {
      const cell = cells[i]!;
      const qtyMatch = /(?:quantity|qty)[:\s]+(\d+)/i.exec(cell) ?? /^(\d+)$/.exec(cell);
      if (qtyMatch) {
        const q = parseInt(qtyMatch[1]!, 10);
        if (q > 0) quantity = q;
      }
    }

    let amountCents: number;
    try {
      amountCents = parseAmountToCents(lastCell);
    } catch {
      continue;
    }

    // Derive unit price if quantity > 1 and amount divides evenly
    if (quantity > 1 && amountCents % quantity === 0) {
      unitPriceCents = Math.abs(amountCents / quantity);
    } else if (quantity === 1) {
      unitPriceCents = Math.abs(amountCents);
    }

    const isReturn = amountCents < 0;
    const refundDestination = isReturn ? parseRefundDestination(cells) : undefined;

    items.push({ name, quantity, amountCents, unitPriceCents, isReturn, refundDestination });
  }

  return items;
}

/**
 * Look for a refund destination hint in any cell of the row.
 * Checks for "Gift Card", "Store Credit", "Balance", "Visa/Mastercard/card" text.
 */
function parseRefundDestination(cells: string[]): RefundDestination | undefined {
  const combined = cells.join(' ').toLowerCase();
  if (combined.includes('gift')) return 'gift_card';
  if (combined.includes('store credit')) return 'store_credit';
  if (combined.includes('balance')) return 'account_balance';
  if (/visa|master|amex|american express|discover|credit|debit|\bcard\b/.test(combined)) {
    return 'card';
  }
  return undefined;
}

/** Parse the order date from the HTML text content. */
function parseOrderDate(text: string): string | undefined {
  // Look for patterns like "Order Date: January 5, 2026" or "Placed on January 5, 2026"
  const patterns = [
    /order\s+(?:date|placed)[:\s]+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /(?:placed|ordered)\s+on\s+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /(?:placed|ordered)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /order\s+date[:\s]+(\d{4}-\d{2}-\d{2})/i,
    /(?:placed|ordered)\s+on[:\s]+(\d{4}-\d{2}-\d{2})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) {
      try {
        return toIsoDate(m[1]);
      } catch {
        // try next pattern
      }
    }
  }
  return undefined;
}

/** Parse the order total from the HTML text content. */
function parseOrderTotal(text: string): number | undefined {
  const m = /order\s+total[:\s]+\$?\s*([\d,]+\.\d{2})/i.exec(text);
  if (m?.[1]) {
    try {
      return parseAmountToCents(m[1]);
    } catch {
      // ignore
    }
  }
  return undefined;
}

/** Parse the goods subtotal (pre-tax/shipping) — the value the line items must
 *  sum to. Used by the reconciliation guard in `parse()`. */
function parseSubtotal(text: string): number | undefined {
  const m = /(?:item\(s\)\s+)?subtotal[:\s]+\$?\s*([\d,]+\.\d{2})/i.exec(text);
  if (m?.[1]) {
    try {
      return parseAmountToCents(m[1]);
    } catch {
      // ignore
    }
  }
  return undefined;
}

export const amazonEmailParser: RetailerEmailParser = {
  retailer: 'amazon',
  gmailQuery:
    'from:(auto-confirm@amazon.com OR ship-confirm@amazon.com OR returns@amazon.com OR return@amazon.com) subject:(order OR refund OR return OR shipped)',

  matches(msg: ParsedEmailMessage): boolean {
    return AMAZON_DOMAIN_RE.test(extractFromAddress(msg.from));
  },

  parse(msg: ParsedEmailMessage): NormalizedOrder {
    const source = msg.html || msg.text;
    const stripped = stripHtml(source);

    // Extract order ID
    const orderIdMatch = AMAZON_ORDER_ID_RE.exec(stripped);
    if (!orderIdMatch?.[1]) {
      throw new Error('Amazon email: could not extract order ID');
    }
    const externalOrderId = orderIdMatch[1];

    // Extract order date
    const orderDate = parseOrderDate(stripped);
    if (!orderDate) {
      throw new Error(`Amazon email: could not extract order date for order ${externalOrderId}`);
    }

    // Extract order total
    const orderTotalCents = parseOrderTotal(stripped);

    // Extract items from HTML table rows.
    const rawItems = parseItemsFromHtml(msg.html || source);

    // A refund/return email re-lists the original purchases (positive) alongside
    // the refunded lines (negative). Those purchases were already booked by the
    // confirmation email, so a refund email contributes ONLY its negative lines —
    // otherwise the unreturned items are double-counted under a distinct
    // shipmentId (avoids the double-book bug).
    const isReturnEmail = /refund|return/i.test(msg.subject);
    const shipmentId = isReturnEmail ? 'return' : 'confirmation';
    const bookable = isReturnEmail ? rawItems.filter((r) => r.isReturn) : rawItems;

    if (bookable.length === 0) {
      throw new Error(
        `Amazon email: no ${isReturnEmail ? 'refund ' : ''}items found in order ${externalOrderId}`,
      );
    }

    // Reconciliation guard: for a purchase confirmation the line items must sum to
    // the order's goods subtotal. A mismatch means a summary/payment row leaked in
    // (or a real item was missed) — skip rather than persist wrong data that would
    // corrupt reconciliation and the store-credit ledger. Falls back to a
    // "must not exceed order total" check when no subtotal line is present.
    if (!isReturnEmail) {
      const purchaseSum = bookable.reduce((sum, r) => sum + r.amountCents, 0);
      const subtotal = parseSubtotal(stripped);
      if (subtotal !== undefined && purchaseSum !== subtotal) {
        throw new Error(
          `Amazon email ${externalOrderId}: items sum ${purchaseSum}¢ ≠ subtotal ${subtotal}¢ — skipping to avoid wrong data`,
        );
      }
      if (subtotal === undefined && orderTotalCents !== undefined && purchaseSum > orderTotalCents) {
        throw new Error(
          `Amazon email ${externalOrderId}: items sum ${purchaseSum}¢ exceeds order total ${orderTotalCents}¢ — skipping`,
        );
      }
    }

    // Build NormalizedOrderItems.
    const items: NormalizedOrderItem[] = bookable.map((raw, idx) => {
      const itemSeq = idx + 1;
      const sourceRowHash = sha256Hex(
        [
          msg.messageId,
          externalOrderId,
          shipmentId,
          String(itemSeq),
          raw.name,
          String(raw.quantity),
          String(raw.amountCents),
        ].join(FIELD_SEP),
      );

      const item: NormalizedOrderItem = {
        shipmentId,
        itemSeq,
        description: raw.name,
        quantity: raw.quantity,
        amountCents: raw.amountCents,
        isReturn: raw.isReturn,
        sourceRowHash,
      };
      if (raw.unitPriceCents !== undefined) item.unitPriceCents = raw.unitPriceCents;
      if (raw.refundDestination !== undefined) item.refundDestination = raw.refundDestination;
      return item;
    });

    const order: NormalizedOrder = {
      source: 'amazon',
      externalOrderId,
      orderDate,
      currency: 'USD',
      items,
    };
    if (orderTotalCents !== undefined) order.orderTotalCents = orderTotalCents;
    return order;
  },
};
