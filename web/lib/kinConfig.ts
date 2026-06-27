import "server-only"
import fs from "fs/promises"
import path from "path"
import { usingTurso, turso } from "./db"

// kin.toml is the household filter config the Python pipeline reads (sender
// allow/blocklists + subject keywords). The tuning UI edits it from the web
// layer. We rewrite only the three filter arrays and leave the rest of the file
// (comments, structure) untouched, so a tuned config stays human-readable.

// Resolved at call time (not module load) so the bundler doesn't trace the whole
// project. KIN_TOML_PATH override is used by tests; production resolves to
// <repo>/kin.toml via KIN_REPO_ROOT (set in .env.local), falling back to cwd/...
function configPath(): string {
  if (process.env.KIN_TOML_PATH) return process.env.KIN_TOML_PATH
  const root = process.env.KIN_REPO_ROOT ?? path.resolve(process.cwd(), "..")
  return path.join(root, "kin.toml")
}

export interface KinConfig {
  sender_allowlist: string[]
  sender_blocklist: string[]
  subject_keywords: string[]
}

const ARRAY_KEYS = ["sender_allowlist", "sender_blocklist", "subject_keywords"] as const

const EMPTY: KinConfig = { sender_allowlist: [], sender_blocklist: [], subject_keywords: [] }

const TEMPLATE = `# kin filter configuration (managed in part by the tuning UI).

[filters]
sender_allowlist = []
sender_blocklist = []
subject_keywords = []
`

function parseArray(text: string, key: string): string[] {
  const m = text.match(new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`))
  if (!m) return []
  return [...m[1].matchAll(/"([^"\\\n]*)"/g)].map((x) => x[1])
}

function parse(text: string): KinConfig {
  return {
    sender_allowlist: parseArray(text, "sender_allowlist"),
    sender_blocklist: parseArray(text, "sender_blocklist"),
    subject_keywords: parseArray(text, "subject_keywords"),
  }
}

export async function readKinConfig(userId?: string): Promise<KinConfig> {
  if (usingTurso() && userId) {
    const rs = await turso().execute({
      sql: "SELECT kind, value FROM filter_entries WHERE user_id = ? ORDER BY kind, value",
      args: [userId],
    })
    const out: KinConfig = { sender_allowlist: [], sender_blocklist: [], subject_keywords: [] }
    for (const row of rs.rows) {
      const kind = String(row.kind)
      if (kind === "sender_allowlist" || kind === "sender_blocklist" || kind === "subject_keywords") {
        out[kind].push(String(row.value))
      }
    }
    return out
  }
  try {
    return parse(await fs.readFile(configPath(), "utf8"))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY }
    throw err
  }
}

// Reject anything that can't be a TOML basic-string value safely.
function sanitize(values: string[]): string[] {
  return values
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && !/["\n\r\\]/.test(v))
}

function renderArray(key: string, values: string[]): string {
  if (values.length === 0) return `${key} = []`
  const body = values.map((v) => `    "${v}",`).join("\n")
  return `${key} = [\n${body}\n]`
}

function setArray(text: string, key: string, values: string[]): string {
  const re = new RegExp(`${key}\\s*=\\s*\\[[\\s\\S]*?\\]`)
  const rendered = renderArray(key, values)
  return re.test(text) ? text.replace(re, rendered) : text
}

export interface TuningPatch {
  allow?: string[]
  block?: string[]
  keyword?: string[]
}

// Apply a batch of tuning answers, returning the number of NEW entries added per
// list (deduped, case-insensitive). Atomic write so a partial write never lands.
export async function applyTuning(
  patch: TuningPatch,
  userId?: string
): Promise<Record<string, number>> {
  const additions: Record<string, string[]> = {
    sender_allowlist: sanitize(patch.allow ?? []),
    sender_blocklist: sanitize(patch.block ?? []),
    subject_keywords: sanitize(patch.keyword ?? []),
  }

  // Production: write to the DB (idempotent per (user, kind, value)). Values are
  // lowercased to match the pipeline's normalization and the seeded entries.
  if (usingTurso() && userId) {
    const added: Record<string, number> = {}
    for (const key of ARRAY_KEYS) {
      let n = 0
      for (const value of additions[key]) {
        const rs = await turso().execute({
          sql: "INSERT OR IGNORE INTO filter_entries (user_id, kind, value) VALUES (?, ?, ?)",
          args: [userId, key, value.toLowerCase()],
        })
        if (Number(rs.rowsAffected) > 0) n++
      }
      added[key] = n
    }
    return added
  }

  // Local dev: rewrite the three arrays in kin.toml, atomic write.
  const p = configPath()
  let text: string
  try {
    text = await fs.readFile(p, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    text = TEMPLATE
  }

  const current = parse(text)
  const added: Record<string, number> = {}
  for (const key of ARRAY_KEYS) {
    const seen = new Set(current[key].map((v) => v.toLowerCase()))
    const fresh = additions[key].filter((v) => !seen.has(v.toLowerCase()))
    added[key] = fresh.length
    if (fresh.length) text = setArray(text, key, [...current[key], ...fresh])
  }

  const tmp = `${p}.tmp-${process.pid}`
  await fs.writeFile(tmp, text, { mode: 0o600 })
  await fs.rename(tmp, p)
  return added
}
