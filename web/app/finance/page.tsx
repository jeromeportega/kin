import { redirect } from "next/navigation"
import { auth } from "@/auth"
import { resolveHouseholdScope, fetchQueue } from "@/lib/finance/server"
import { DEFAULT_CATEGORIES } from "@/lib/finance/db/schema"
import { plaidConfigured } from "@/lib/finance/plaid/client"
import { hasPlaidItem } from "@/lib/finance/plaid/server"
import { receiptScanConfigured } from "@/lib/finance/receipts/server"
import { QueueView } from "@/components/finance/queue/QueueView"
import { QueueItemActions } from "@/components/finance/queue/QueueItemActions"
import { FinanceUpload } from "@/components/finance/FinanceUpload"
import { PlaidConnect } from "@/components/finance/PlaidConnect"
import { ReceiptScan } from "@/components/finance/ReceiptScan"
import { EmailReceiptImport } from "./EmailReceiptImport"

export const dynamic = "force-dynamic"

export default async function FinancePage() {
  const session = await auth()
  if (!session?.user?.email) redirect("/signin")

  const scope = await resolveHouseholdScope(session.user.email)
  const plaidEnabled = plaidConfigured()
  const hasBank = plaidEnabled ? await hasPlaidItem(scope) : false
  const receiptScanEnabled = receiptScanConfigured()
  const items = await fetchQueue(scope)

  return (
    <main className="container mx-auto max-w-4xl py-8 px-4">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">Finance — Review Queue</h1>
        <p className="text-sm text-muted-foreground">
          Items that need a look before every dollar is counted once. Import bank and
          Amazon exports, and anything the reconcile loop is unsure of lands here.
        </p>
      </div>
      {plaidEnabled && <PlaidConnect hasBank={hasBank} />}
      <FinanceUpload />
      <EmailReceiptImport />
      {receiptScanEnabled && <ReceiptScan />}
      <QueueView
        items={items}
        renderActions={(item) => <QueueItemActions item={item} categories={[...DEFAULT_CATEGORIES]} />}
      />
    </main>
  )
}
