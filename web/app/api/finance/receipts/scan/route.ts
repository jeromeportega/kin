import "server-only"
import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { resolveHouseholdScope } from "@/lib/finance/server"
import { scanReceipt, receiptScanConfigured } from "@/lib/finance/receipts/server"
import { isSupportedMimeType } from "@/lib/finance/core/receipts/vision/vision-provider"

// A receipt photo/PDF is well under this; the cap bounds an oversized upload
// before it becomes base64 + an LLM request. (Vercel also caps the body ~4.5MB.)
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** POST /api/finance/receipts/scan — multipart { file }. Runs a receipt photo /
 *  PDF through Claude vision → item-level receipt in the signed-in household. */
export async function POST(request: Request): Promise<Response> {
  const session = await auth()
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthenticated" }, { status: 401 })
  }
  if (!receiptScanConfigured()) {
    return Response.json({ error: "Receipt scanning is not configured" }, { status: 503 })
  }

  const form = await request.formData()
  const file = form.get("file")
  if (!(file instanceof File)) {
    return Response.json({ error: "file is required" }, { status: 400 })
  }
  if (!isSupportedMimeType(file.type)) {
    return Response.json(
      { error: `Unsupported file type "${file.type}". Use JPEG, PNG, or PDF.` },
      { status: 400 },
    )
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "File too large (max 10 MB)." }, { status: 413 })
  }

  const scope = await resolveHouseholdScope(session.user.email)
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const result = await scanReceipt(scope, bytes, file.type)
    revalidatePath("/finance")
    return Response.json({ ok: true, ...result })
  } catch (err) {
    // Don't leak provider/DB internals to the client; log server-side.
    console.error("receipt scan failed:", err)
    return Response.json({ ok: false, error: "Receipt scan failed. Please try again." }, { status: 500 })
  }
}
