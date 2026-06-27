import "server-only"
import type { Digest, Classification } from "@/lib/types"

function baseUrl(): string {
  const url = process.env.KIN_API_BASE_URL
  if (!url) throw new Error("KIN_API_BASE_URL is not configured")
  return url
}

export async function fetchDigest(userId: string): Promise<Digest | null> {
  const url = `${baseUrl()}/api/digest/latest?user_id=${encodeURIComponent(userId)}`
  const res = await fetch(url)
  if (res.status === 204) return null
  if (!res.ok) throw new Error(`fetchDigest failed: ${res.status}`)
  const data: Digest = await res.json()
  if (!data.items || data.items.length === 0) return null
  return data
}

export async function fetchClassifications(
  userId: string,
  hours: number
): Promise<Classification[]> {
  const url = `${baseUrl()}/api/classifications?user_id=${encodeURIComponent(userId)}&hours=${hours}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetchClassifications failed: ${res.status}`)
  return res.json()
}
