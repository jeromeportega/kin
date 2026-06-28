import "server-only"
import { dbClient } from "@/lib/db"
import { runIngest } from "@/lib/ingest"

// Daily cron (scheduled in vercel.json): run the ingest + digest for every user
// with a stored Gmail token. Vercel sends `Authorization: Bearer $CRON_SECRET`.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  const rs = await dbClient().execute({ sql: "SELECT email FROM gmail_tokens" })
  const results: Record<string, unknown>[] = []
  for (const row of rs.rows) {
    const email = String(row.email)
    try {
      results.push({ email, ...(await runIngest(email)) })
    } catch (err) {
      results.push({ email, error: String(err) })
    }
  }
  return Response.json({ ok: true, results })
}
