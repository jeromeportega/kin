import type {
  NewReceipt,
  NewReceiptItem,
  ReceiptItemRecord,
  ReceiptRecord,
  ReceiptStore,
} from "../core/receipts/store/receipt-store"

/**
 * Scopes the image-hash idempotency lookup to ONE household. The underlying
 * store's `findReceiptByImageHash` is global (clarity was single-household), so a
 * byte-identical receipt uploaded by a DIFFERENT household would collide — that
 * household would get `idempotent: true` against another's receipt and silently
 * never store its own. Wrapping the lookup restores multi-tenant isolation; all
 * writes already carry householdId, so they pass straight through.
 */
export class HouseholdScopedReceiptStore implements ReceiptStore {
  constructor(
    private readonly inner: ReceiptStore,
    private readonly householdId: string,
  ) {}

  async findReceiptByImageHash(hash: string): Promise<ReceiptRecord | null> {
    const r = await this.inner.findReceiptByImageHash(hash)
    return r && r.householdId === this.householdId ? r : null
  }

  insertReceipt(r: NewReceipt): Promise<ReceiptRecord> {
    return this.inner.insertReceipt(r)
  }

  insertReceiptItems(items: NewReceiptItem[]): Promise<ReceiptItemRecord[]> {
    return this.inner.insertReceiptItems(items)
  }

  listCategories(): Promise<readonly string[]> {
    return this.inner.listCategories()
  }
}
