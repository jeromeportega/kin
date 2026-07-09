import type { NormalizedOrder, NormalizedOrderItem, RefundDestination } from '../../model/normalized';
import { sha256Hex } from '../../idempotency/keys';
import { parseAmountToCents, toIsoDate } from '../../normalize';
import type { ParsedEmailMessage } from './types';
import { extractTagBlocks, innerText, stripHtml, MAX_HTML_BYTES } from './html';

/**
 * Retailer-agnostic parsing for order/receipt emails that render items in an
 * HTML table (Amazon, Walmart, Target, …). A retailer parser supplies only its
 * identity + order-id pattern (see RetailerOrderConfig); everything below —
 * item extraction, the summary/payment-row denylist, the reconciliation +
 * negative-line guards, message-scoped shipmentId, and the deterministic
 * sourceRowHash — is shared, so a hardening fix lands for every retailer at once.
 */

const FIELD_SEP = '\x00';

interface RawItem {
  name: string;
  quantity: number;
  amountCents: number;
  unitPriceCents?: number;
  isReturn: boolean;
  refundDestination?: RefundDestination;
}

/**
 * Order-summary and payment rows render as `<tr>` with a price cell but are NOT
 * line items: Subtotal / Shipping / Tax / (Grand|Order) Total, and payment lines
 * like gift-card / promotion / store-credit applied. Capturing these inflates the
 * item set and — because summary payment lines are negative — mis-books them as
 * returns (phantom store credit). Reject any row whose first cell is one of these
 * labels. Anchored at start so a product titled "Total Wireless …" (name doesn't
 * start with the payment phrasing) is kept; the reconciliation guard backstops.
 */
const SUMMARY_LABEL_RE =
  /^(sub[\s-]?total|item\(s\)\s+subtotal|shipping(\s*&(amp;)?\s*handling)?|handling|free\s+shipping|estimated\s+tax|sales\s+tax|tax|total\s+before\s+tax|order\s+total|grand\s+total|total|promotion(s)?(\s+applied)?|promo(tion)?\s+code|discount(s)?|coupon|savings|gift\s*card\s+(amount|balance|applied)|store\s+credit\s+(amount|balance|applied)|balance\s+applied|rewards?\s+(points?|applied)|import\s+fees?(\s+deposit)?)\b/i;

function isSummaryOrPaymentLabel(name: string): boolean {
  return SUMMARY_LABEL_RE.test(name.trim());
}

/** Extract the bare address-spec from a From header, stripping any display name. */
export function extractFromAddress(from: string): string {
  const angleMatch = /<([^>]*)>/.exec(from);
  if (angleMatch?.[1]) return angleMatch[1].trim().toLowerCase();
  return from.trim().toLowerCase();
}

/**
 * Shipment / delivery / pickup notice subjects. These RE-LIST the ordered items
 * with no reconcilable subtotal, so booking them double-counts against the
 * confirmation — and no parse guard can see it (the email is internally
 * consistent). Retailers that send order confirmations AND shipment notices from
 * ONE sender address (Walmart's help@, Target's orders@) must reject these in
 * `matches()`. (Amazon instead disambiguates by sender address.)
 */
const SHIPMENT_SUBJECT_RE =
  /shipp(ed|ing)|on (its|the) way|out for delivery|delivered|delivery\s+(update|notification|status)|ready for (pickup|drive[\s-]?up|collection)|pick(ed|ing)\s*up|\btrack\b|tracking|arriv|it'?s here/i;

export function isShipmentNotice(subject: string): boolean {
  return SHIPMENT_SUBJECT_RE.test(subject);
}

/**
 * Parse items from an HTML table: rows with ≥2 cells whose last cell is a price
 * ($X.XX / -$X.XX / ($X.XX)). Summary/payment/header rows are rejected.
 */
function parseItemsFromHtml(html: string): RawItem[] {
  const safe = html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
  const items: RawItem[] = [];

  for (const rowContent of extractTagBlocks(safe, 'tr')) {
    const cells = extractTagBlocks(rowContent, 'td').map(innerText);
    if (cells.length < 2) continue;

    const lastCell = cells[cells.length - 1]!;
    const priceMatch = /^(-?\s*\$[\d,]+\.\d{2}|\(\s*\$[\d,]+\.\d{2}\s*\))$/.exec(lastCell);
    if (!priceMatch) continue;

    const name = cells[0]!;
    if (!name || name.length === 0) continue;
    if (/^(item|product|description|name)$/i.test(name)) continue; // header
    if (isSummaryOrPaymentLabel(name)) continue; // summary / payment row

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

/** Refund-destination hint from any cell of a return row. */
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

/** Order date from the stripped text. Common US retailer phrasings. */
function parseOrderDate(text: string): string | undefined {
  const patterns = [
    /order\s+(?:date|placed)[:\s]+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /(?:placed|ordered)\s+on\s+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /(?:placed|ordered)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /order\s+date[:\s]+(\d{4}-\d{2}-\d{2})/i,
    /(?:placed|ordered)\s+on[:\s]+(\d{4}-\d{2}-\d{2})/i,
    /order\s+date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i,
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

/** Grand total ("order total") from the stripped text. */
function parseOrderTotal(text: string): number | undefined {
  const m = /order\s+total[:\s]+\$?\s*([\d,]+\.\d{2})/i.exec(text);
  if (m?.[1]) {
    try {
      return parseAmountToCents(m[1]);
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/** Goods subtotal (pre-tax/shipping) — the value the line items must sum to. */
function parseSubtotal(text: string): number | undefined {
  const m = /(?:item\(s\)\s+)?subtotal[:\s]+\$?\s*([\d,]+\.\d{2})/i.exec(text);
  if (m?.[1]) {
    try {
      return parseAmountToCents(m[1]);
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export interface RetailerOrderConfig {
  /** Source tag stored on the order (also the reconcile/dedup grouping). */
  retailer: NormalizedOrder['source'];
  /** Human label for error messages, e.g. "Amazon email". */
  label: string;
  /** Extracts the external order id from the stripped text. */
  orderIdRe: RegExp;
}

/**
 * Turn a tabular order/receipt email into a NormalizedOrder. Throws on truly
 * malformed input or when a guard fails — the adapter catches and records an
 * ImportError (FR-10: skip, never persist wrong data).
 */
export function buildTabularOrder(msg: ParsedEmailMessage, config: RetailerOrderConfig): NormalizedOrder {
  const source = msg.html || msg.text;
  const stripped = stripHtml(source);

  const orderIdMatch = config.orderIdRe.exec(stripped);
  if (!orderIdMatch?.[1]) {
    throw new Error(`${config.label}: could not extract order ID`);
  }
  const externalOrderId = orderIdMatch[1];

  const orderDate = parseOrderDate(stripped);
  if (!orderDate) {
    throw new Error(`${config.label}: could not extract order date for order ${externalOrderId}`);
  }

  const orderTotalCents = parseOrderTotal(stripped);
  const rawItems = parseItemsFromHtml(source);

  // A refund/return email re-lists the original purchases (positive) alongside
  // the refunded lines (negative); those were booked by the confirmation, so a
  // refund email contributes ONLY its negative lines (avoids double-booking).
  const isReturnEmail = /refund|return/i.test(msg.subject);
  // Scope shipmentId to the Gmail message id: the DB dedup key is
  // (orderId, shipmentId, itemSeq) WITHOUT sourceRowHash, so a bare
  // 'return'/'confirmation' collides across distinct emails for the same order
  // (e.g. two partial refunds). messageId keeps them distinct + idempotent.
  const shipmentId = `${isReturnEmail ? 'return' : 'confirmation'}:${msg.messageId}`;
  const bookable = isReturnEmail ? rawItems.filter((r) => r.isReturn) : rawItems;

  if (bookable.length === 0) {
    throw new Error(
      `${config.label}: no ${isReturnEmail ? 'refund ' : ''}items found in order ${externalOrderId}`,
    );
  }

  if (!isReturnEmail) {
    // A purchase confirmation has no negative line items. A negative bookable
    // line means a payment/discount row (gift card, promo) slipped past the
    // summary denylist — booking it would create a phantom store-credit "return".
    // Skip fail-closed (closes the direction the sum guard below can't see).
    if (bookable.some((r) => r.amountCents < 0)) {
      throw new Error(
        `${config.label} ${externalOrderId}: unexpected negative line item in a purchase confirmation — skipping (likely a leaked payment/discount row)`,
      );
    }
    // Reconciliation guard: the line items must sum to the stated subtotal, else
    // a summary row leaked or an item was missed — skip rather than persist wrong
    // data. Falls back to "must not exceed order total" when no subtotal parses.
    const purchaseSum = bookable.reduce((sum, r) => sum + r.amountCents, 0);
    const subtotal = parseSubtotal(stripped);
    if (subtotal !== undefined && purchaseSum !== subtotal) {
      throw new Error(
        `${config.label} ${externalOrderId}: items sum ${purchaseSum}¢ ≠ subtotal ${subtotal}¢ — skipping to avoid wrong data`,
      );
    }
    if (subtotal === undefined && orderTotalCents !== undefined && purchaseSum > orderTotalCents) {
      throw new Error(
        `${config.label} ${externalOrderId}: items sum ${purchaseSum}¢ exceeds order total ${orderTotalCents}¢ — skipping`,
      );
    }
  }

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
    source: config.retailer,
    externalOrderId,
    orderDate,
    currency: 'USD',
    items,
  };
  if (orderTotalCents !== undefined) order.orderTotalCents = orderTotalCents;
  return order;
}
