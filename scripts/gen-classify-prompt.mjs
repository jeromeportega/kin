// Generate web/lib/classifyPrompt.ts from the canonical app/prompts/classify.txt.
//
// The TS classifier needs the prompt embedded as a string (reliably bundled into
// the Vercel function — no runtime fs), while the Python eval keeps reading the
// .txt. This keeps app/prompts/classify.txt the single source of truth; the
// generated copy is byte-identical (drift-guarded by classifyPrompt.test.ts), so
// the sha256 prompt_version matches across both pipelines.
//
//   node scripts/gen-classify-prompt.mjs
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const raw = readFileSync(join(root, "app/prompts/classify.txt"), "utf8")

// Escape for a template literal: backslash first, then backtick, then ${.
const escaped = raw.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")

const out = `// GENERATED from app/prompts/classify.txt — do not edit by hand.
// Regenerate with: node scripts/gen-classify-prompt.mjs
// Drift-guarded by web/lib/__tests__/classifyPrompt.test.ts.

export const CLASSIFY_PROMPT = \`${escaped}\`
`

writeFileSync(join(root, "web/lib/classifyPrompt.ts"), out)
console.log(`wrote web/lib/classifyPrompt.ts (${raw.length} chars)`)
