import { eq, inArray } from 'drizzle-orm';

import type { FinanceDb } from '../../db/client';
import {
  accounts,
  orderItems,
  orders,
  receiptItems,
  receipts,
  storeCreditBalances,
  transactions,
} from '../../db/schema';
import { FIXTURE_INPUTS } from './__fixtures__/index';
import type {
  BankLine,
  OrderItemView,
  OrderView,
  ReceiptItemView,
  ReceiptView,
  ReconcileInputs,
  StoreCreditAccrual,
} from './model';

export interface ReconcileSource {
  load(householdId: string): Promise<ReconcileInputs>;
}

/**
 * In-memory fixture source used in tests and the gate. Returns the synthetic
 * corpus from `__fixtures__/index.ts`, overriding its householdId with the
 * caller's so fixture data is addressable by any test household.
 */
export class FixtureReconcileSource implements ReconcileSource {
  async load(householdId: string): Promise<ReconcileInputs> {
    return {
      ...FIXTURE_INPUTS,
      householdId,
      bankLines: FIXTURE_INPUTS.bankLines.map((b) => ({ ...b })),
      orders: FIXTURE_INPUTS.orders.map((o) => ({ ...o, items: o.items.map((i) => ({ ...i })) })),
      receipts: FIXTURE_INPUTS.receipts.map((r) => ({ ...r, items: r.items.map((i) => ({ ...i })) })),
      storeCreditAccruals: FIXTURE_INPUTS.storeCreditAccruals.map((a) => ({ ...a })),
    };
  }
}

/**
 * DB-backed source: reads a household's ingested corpus (bank transactions,
 * Amazon orders, receipts, store-credit accruals) out of the shared kin DB and
 * shapes it into `ReconcileInputs` for the engine.
 *
 * Read-only and household-scoped: every query filters by `householdId` (bank
 * lines via their account) so one household's reconcile never sees another's
 * rows. Amounts are loaded as stored — signed integer cents, debits negative —
 * which is exactly what the matchers expect (they `Math.abs` where needed).
 */
export class DrizzleReconcileSource implements ReconcileSource {
  constructor(private readonly db: FinanceDb) {}

  async load(householdId: string): Promise<ReconcileInputs> {
    const bankLines = await this.loadBankLines(householdId);
    const ordersView = await this.loadOrders(householdId);
    const receiptsView = await this.loadReceipts(householdId);
    const storeCreditAccruals = await this.loadStoreCreditAccruals(householdId);
    return { householdId, bankLines, orders: ordersView, receipts: receiptsView, storeCreditAccruals };
  }

  /** Bank transactions for the household, joined through their account. */
  private async loadBankLines(householdId: string): Promise<BankLine[]> {
    const rows = await this.db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        postedDate: transactions.postedDate,
        amountCents: transactions.amountCents,
        direction: transactions.direction,
        normalizedMerchant: transactions.normalizedMerchant,
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(eq(accounts.householdId, householdId));
    // Shape matches BankLine exactly; lastFour is unknown for imported bank rows
    // (neither transactions nor accounts store a card number) and stays absent —
    // receipt↔bank scoring treats an absent lastFour as neutral.
    return rows;
  }

  /** Amazon orders + their line items for the household. */
  private async loadOrders(householdId: string): Promise<OrderView[]> {
    const orderRows = await this.db
      .select({
        id: orders.id,
        externalOrderId: orders.externalOrderId,
        orderDate: orders.orderDate,
        orderTotalCents: orders.orderTotalCents,
      })
      .from(orders)
      .where(eq(orders.householdId, householdId));
    if (orderRows.length === 0) return [];

    const itemRows = await this.db
      .select({
        id: orderItems.id,
        orderId: orderItems.orderId,
        shipmentId: orderItems.shipmentId,
        description: orderItems.description,
        amountCents: orderItems.amountCents,
        isReturn: orderItems.isReturn,
        refundDestination: orderItems.refundDestination,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderRows.map((o) => o.id)));

    const itemsByOrder = new Map<string, OrderItemView[]>();
    for (const it of itemRows) {
      const view: OrderItemView = {
        id: it.id,
        shipmentId: it.shipmentId,
        description: it.description,
        amountCents: it.amountCents,
        isReturn: it.isReturn,
        refundDestination: it.refundDestination ?? undefined,
      };
      const list = itemsByOrder.get(it.orderId) ?? [];
      list.push(view);
      itemsByOrder.set(it.orderId, list);
    }

    return orderRows.map((o) => ({
      id: o.id,
      externalOrderId: o.externalOrderId,
      orderDate: o.orderDate,
      orderTotalCents: o.orderTotalCents ?? undefined,
      items: itemsByOrder.get(o.id) ?? [],
    }));
  }

  /** Receipts + their line items for the household. */
  private async loadReceipts(householdId: string): Promise<ReceiptView[]> {
    const receiptRows = await this.db
      .select({
        id: receipts.id,
        store: receipts.store,
        purchasedAt: receipts.purchasedAt,
        totalCents: receipts.totalCents,
        paymentLast4: receipts.paymentLast4,
      })
      .from(receipts)
      .where(eq(receipts.householdId, householdId));
    if (receiptRows.length === 0) return [];

    const itemRows = await this.db
      .select({
        id: receiptItems.id,
        receiptId: receiptItems.receiptId,
        canonicalName: receiptItems.canonicalName,
        rawDescription: receiptItems.rawDescription,
        linePriceCents: receiptItems.linePriceCents,
      })
      .from(receiptItems)
      .where(inArray(receiptItems.receiptId, receiptRows.map((r) => r.id)));

    const itemsByReceipt = new Map<string, ReceiptItemView[]>();
    for (const it of itemRows) {
      const view: ReceiptItemView = {
        id: it.id,
        description: it.canonicalName ?? it.rawDescription,
        amountCents: it.linePriceCents,
      };
      const list = itemsByReceipt.get(it.receiptId) ?? [];
      list.push(view);
      itemsByReceipt.set(it.receiptId, list);
    }

    return receiptRows.map((r) => ({
      id: r.id,
      merchant: r.store,
      capturedAt: r.purchasedAt,
      totalCents: r.totalCents,
      lastFour: r.paymentLast4 ?? undefined,
      items: itemsByReceipt.get(r.id) ?? [],
    }));
  }

  /**
   * Store-credit accruals for the household. `orderId` is derived by joining the
   * accrual's order item back to its order — the strongest signal the refund
   * matcher uses to attribute a store-credit refund to the return that earned it.
   * `occurredAt` is the accrual's created date (YYYY-MM-DD).
   */
  private async loadStoreCreditAccruals(householdId: string): Promise<StoreCreditAccrual[]> {
    const rows = await this.db
      .select({
        id: storeCreditBalances.id,
        kind: storeCreditBalances.kind,
        amountCents: storeCreditBalances.amountCents,
        createdAt: storeCreditBalances.createdAt,
        orderItemId: storeCreditBalances.orderItemId,
        orderId: orderItems.orderId,
      })
      .from(storeCreditBalances)
      .leftJoin(orderItems, eq(storeCreditBalances.orderItemId, orderItems.id))
      .where(eq(storeCreditBalances.householdId, householdId));

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      amountCents: r.amountCents,
      occurredAt: (r.createdAt ?? '').slice(0, 10),
      orderId: r.orderId ?? undefined,
      orderItemId: r.orderItemId ?? undefined,
    }));
  }
}
