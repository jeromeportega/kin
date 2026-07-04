import type { NormalizedOrder, NormalizedOrderItem, RefundDestination } from '../../../model/normalized';
import { sha256Hex } from '../../../idempotency/keys';
import { parseAmountToCents, toIsoDate } from '../../../normalize';
import type { ParsedEmailMessage, RetailerEmailParser } from '../types';

/** Cap HTML before regex to guard against ReDoS on malformed input. */
const MAX_HTML_BYTES = 2 * 1024 * 1024;

const AMAZON_FROM_RE = /\bamazon\.com\b/i;
const AMAZON_ORDER_ID_RE = /\b(\d{3}-\d{7}-\d{7})\b/;

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

export const amazonEmailParser: RetailerEmailParser = {
  retailer: 'amazon',
  gmailQuery:
    'from:(auto-confirm@amazon.com OR ship-confirm@amazon.com OR returns@amazon.com OR return@amazon.com) subject:(order OR refund OR return OR shipped)',

  matches(msg: ParsedEmailMessage): boolean {
    if (AMAZON_FROM_RE.test(msg.from)) return true;
    const subjectLower = msg.subject.toLowerCase();
    return (
      subjectLower.includes('amazon') &&
      (subjectLower.includes('order') || subjectLower.includes('refund') || subjectLower.includes('return') || subjectLower.includes('shipped'))
    );
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

    // Extract items from HTML table rows
    const rawItems = parseItemsFromHtml(msg.html || source);

    if (rawItems.length === 0) {
      throw new Error(`Amazon email: no items found in order ${externalOrderId}`);
    }

    // Build NormalizedOrderItems — shipmentId is derived from context
    const isReturnEmail = /refund|return/i.test(msg.subject);
    const shipmentId = isReturnEmail ? 'return' : 'confirmation';

    const items: NormalizedOrderItem[] = rawItems.map((raw, idx) => {
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
