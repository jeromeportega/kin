import "server-only"
import type { Digest, Classification } from "@/lib/types"

function baseUrl(): string {
  const url = process.env.KIN_API_BASE_URL
  if (!url) throw new Error("KIN_API_BASE_URL is not configured")
  return url
}

const fetchOptions = (): RequestInit => ({
  cache: "no-store",
  signal: AbortSignal.timeout(5000),
})

export async function fetchDigest(userId: string): Promise<Digest | null> {
  if (!userId) throw new Error("userId is required")
  const url = `${baseUrl()}/api/digest/latest?user_id=${encodeURIComponent(userId)}`
  const res = await fetch(url, fetchOptions())
  if (res.status === 204) return null
  if (!res.ok) throw new Error(`fetchDigest failed: ${res.status}`)
  const data: Digest = await res.json()
  if (data.items.length === 0) return null
  return data
}

export async function fetchClassifications(
  userId: string,
  hours: number
): Promise<Classification[]> {
  if (!userId) throw new Error("userId is required")
  if (!Number.isInteger(hours) || hours <= 0) {
    throw new Error("hours must be a positive integer")
  }
  const url = `${baseUrl()}/api/classifications?user_id=${encodeURIComponent(userId)}&hours=${hours}`
  const res = await fetch(url, fetchOptions())
  if (!res.ok) throw new Error(`fetchClassifications failed: ${res.status}`)
  return res.json() as Promise<Classification[]>
}
