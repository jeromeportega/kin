import "server-only"
import { createHash } from "node:crypto"
import Anthropic from "@anthropic-ai/sdk"
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"
import { z } from "zod"
import { CLASSIFY_PROMPT } from "./classifyPrompt"

// TS port of app/classify_email.py — same model, max_tokens, cached system block,
// no sampling params, and schema-validated output. Sonnet is the right tier for
// high-volume rubric-driven classification (validated by app.eval).
export const MODEL = "claude-sonnet-4-6"
const MAX_TOKENS = 1024

// Same scheme as the Python pipeline: sha256 of the prompt, first 12 hex chars.
// Stored on each classification so a prompt change invalidates the dedup cache.
export const PROMPT_VERSION = createHash("sha256").update(CLASSIFY_PROMPT).digest("hex").slice(0, 12)

export const CATEGORIES = [
  "daycare",
  "medical",
  "travel",
  "finance",
  "shopping",
  "personal",
  "other",
] as const
export const PRIORITIES = ["low", "medium", "high"] as const

export const EmailClassificationSchema = z.object({
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  action_required: z.boolean(),
  summary: z.string(),
  action_items: z.array(z.string()),
  dates: z.array(z.string()),
  confidence: z.number().min(0).max(1),
})
export type EmailClassification = z.infer<typeof EmailClassificationSchema>

// Lazily constructed so importing this module never requires ANTHROPIC_API_KEY
// (tests mock the SDK; the key is only needed for a real classification call).
let _client: Anthropic | null = null
function client(): Anthropic {
  if (!_client) _client = new Anthropic() // reads ANTHROPIC_API_KEY from the environment
  return _client
}

export async function classify(
  emailText: string,
  model: string = MODEL
): Promise<EmailClassification> {
  // Split the prompt at {{EMAIL}} so the large, stable instruction block is sent
  // as a cached `system` prefix and only the volatile email varies per request.
  // (Prompt caching no-ops until the prefix clears the model's minimum, but the
  // structure is correct for when the prompt grows.)
  const [instructions, closing] = CLASSIFY_PROMPT.split("{{EMAIL}}")

  const message = await client().messages.parse({
    model,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: instructions, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: emailText + closing }],
    output_format: zodOutputFormat(EmailClassificationSchema),
  })

  if (!message.parsed_output) {
    throw new Error(
      `classification returned no parsed output (stop_reason=${message.stop_reason})`
    )
  }
  return message.parsed_output
}
