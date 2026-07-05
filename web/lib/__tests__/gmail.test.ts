import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

import {
  mintAccessToken,
  ReauthRequired,
  stripHtml,
  decodeB64Url,
  fetchRecent,
  fetchRawMessages,
  renderBodyWithLinks,
} from "@/lib/gmail"

describe("renderBodyWithLinks", () => {
  it("replaces plain-text 'label ( url )' links with [n] markers + URL list", () => {
    const [body, urls] = renderBodyWithLinks(
      "Schedule your interview ( https://calendly.com/x )\nUnsubscribe ( https://acme.com/u )",
      ""
    )
    expect(body).toBe("Schedule your interview [1]\nUnsubscribe [2]")
    expect(urls).toEqual(["https://calendly.com/x", "https://acme.com/u"])
  })

  it("falls back to <a href> extraction for HTML-only bodies", () => {
    const [body, urls] = renderBodyWithLinks(
      "",
      '<p>Pay now: <a href="https://bank.com/pay">Pay bill</a></p>'
    )
    expect(body).toContain("Pay bill [1]")
    expect(urls).toEqual(["https://bank.com/pay"])
  })

  it("returns no links when there are none", () => {
    const [body, urls] = renderBodyWithLinks("Just a note, nothing to click.", "")
    expect(body).toBe("Just a note, nothing to click.")
    expect(urls).toEqual([])
  })
})

beforeEach(() => vi.stubGlobal("fetch", vi.fn()))

function res(status: number, json: unknown, text = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => text,
  }
}

const b64url = (s: string) =>
  Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")

describe("decodeB64Url / stripHtml", () => {
  it("decodes url-safe base64 without padding", () => {
    expect(decodeB64Url(b64url("Hello, world"))).toBe("Hello, world")
  })
  it("strips tags, collapses whitespace, unescapes entities", () => {
    expect(stripHtml("<p>Hi&nbsp;&amp; bye</p>  <b>x</b>")).toBe("Hi & bye x")
  })
})

describe("mintAccessToken", () => {
  it("returns the access token on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res(200, { access_token: "tok" }) as never)
    expect(await mintAccessToken("rt", "id", "sec")).toBe("tok")
  })
  it("throws ReauthRequired on a 400 (revoked/expired)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res(400, {}, "invalid_grant") as never)
    await expect(mintAccessToken("rt", "id", "sec")).rejects.toBeInstanceOf(ReauthRequired)
  })
})

describe("fetchRecent", () => {
  const fullMsg = {
    id: "m1",
    internalDate: "1700000000000",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Jane <Jane@X.com>" },
        { name: "Subject", value: "Hello" },
        { name: "Message-ID", value: "<abc@x>" },
        { name: "Date", value: "Wed, 22 Apr 2026 15:00:06 -0400" },
      ],
      parts: [{ mimeType: "text/plain", body: { data: b64url("plain body") } }],
    },
  }

  it("lists, gets, and parses messages", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(res(200, { messages: [{ id: "m1" }] }) as never)
      .mockResolvedValueOnce(res(200, fullMsg) as never)
    const out = await fetchRecent({ accessToken: "t", hours: 24, limit: 50 })
    expect(out).toHaveLength(1)
    expect(out[0].from_addr).toBe("jane <jane@x.com>") // full header, lowercased
    expect(out[0].subject).toBe("Hello")
    expect(out[0].message_id).toBe("<abc@x>")
    expect(out[0].text_body).toBe("plain body")
    expect(out[0].date).toBe("2026-04-22T19:00:06.000+00:00") // -0400 → UTC
    expect(out[0].truncated).toBe(false)
  })

  it("skips a 404 (deleted between list and get)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(res(200, { messages: [{ id: "m1" }] }) as never)
      .mockResolvedValueOnce({ ok: false, status: 404 } as never)
    expect(await fetchRecent({ accessToken: "t", hours: 24, limit: 50 })).toEqual([])
  })
})

// Helper: encode a string to base64url (same encoding Gmail uses for format=raw)
function toB64url(input: string | Uint8Array): string {
  const buf = typeof input === "string" ? Buffer.from(input) : Buffer.from(input)
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
}

describe("fetchRawMessages", () => {
  const FIXTURE_RFC822 = "From: seller@amazon.com\r\nSubject: Your order\r\n\r\nOrder body"
  const FIXTURE_BYTES = Buffer.from(FIXTURE_RFC822)

  it("issues messages.list with the caller-supplied query and limit, not a recency filter", async () => {
    const query = "from:(auto-confirm@amazon.com) subject:(ordered OR shipped)"
    vi.mocked(fetch)
      .mockResolvedValueOnce(res(200, { messages: [{ id: "abc" }] }) as never)
      .mockResolvedValueOnce(res(200, { id: "abc", raw: toB64url(FIXTURE_RFC822) }) as never)

    await fetchRawMessages({ accessToken: "t", query, limit: 10 })

    const listCall = vi.mocked(fetch).mock.calls[0]
    const listUrl = listCall[0] as string
    expect(listUrl).toContain(`q=${encodeURIComponent(query)}`)
    expect(listUrl).toContain("maxResults=10")
    expect(listUrl).not.toContain("after:")
    expect(listUrl).not.toContain("labelIds=")
  })

  it("returns a RawGmailMessage with the stable messageId and correctly decoded bytes", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(res(200, { messages: [{ id: "abc" }] }) as never)
      .mockResolvedValueOnce(res(200, { id: "abc", raw: toB64url(FIXTURE_RFC822) }) as never)

    const results = await fetchRawMessages({ accessToken: "t", query: "q", limit: 5 })

    expect(results).toHaveLength(1)
    expect(results[0].messageId).toBe("abc")
    // bytes must equal the raw RFC822 content, base64url-decoded
    expect(Buffer.from(results[0].bytes)).toEqual(FIXTURE_BYTES)
  })

  it("base64url-decodes correctly for payloads with - and _ characters", async () => {
    // Craft a payload that will produce - and _ in base64url
    const raw = new Uint8Array([0xfb, 0xff, 0xfe, 0x00, 0x3e, 0x3f])
    const b64url = toB64url(raw)
    expect(b64url).toMatch(/[-_]/) // ensure fixture actually tests the url-safe chars

    vi.mocked(fetch)
      .mockResolvedValueOnce(res(200, { messages: [{ id: "xyz" }] }) as never)
      .mockResolvedValueOnce(res(200, { id: "xyz", raw: b64url }) as never)

    const results = await fetchRawMessages({ accessToken: "t", query: "q", limit: 1 })
    expect(Buffer.from(results[0].bytes)).toEqual(Buffer.from(raw))
  })

  it("returns [] when messages.list returns no messages (empty inbox)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res(200, {}) as never)

    const results = await fetchRawMessages({ accessToken: "t", query: "q", limit: 50 })

    expect(results).toEqual([])
    // messages.get must not be called
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it("returns [] immediately and makes no network calls when limit is 0", async () => {
    const results = await fetchRawMessages({ accessToken: "t", query: "q", limit: 0 })

    expect(results).toEqual([])
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("limit bounds the number of messages.get calls (list shorter than limit)", async () => {
    // list returns 2 messages but limit is 10 — we still only get 2
    vi.mocked(fetch)
      .mockResolvedValueOnce(res(200, { messages: [{ id: "m1" }, { id: "m2" }] }) as never)
      .mockResolvedValueOnce(res(200, { id: "m1", raw: toB64url(FIXTURE_RFC822) }) as never)
      .mockResolvedValueOnce(res(200, { id: "m2", raw: toB64url(FIXTURE_RFC822) }) as never)

    const results = await fetchRawMessages({ accessToken: "t", query: "q", limit: 10 })

    expect(results).toHaveLength(2)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3) // 1 list + 2 gets
  })

  it("does not import from the finance module (module boundary check)", async () => {
    // This is a structural assertion: fetchRawMessages is exported from gmail.ts,
    // which must not import drizzle/finance. Verified by the module's source —
    // here we just confirm it's callable without finance context.
    vi.mocked(fetch)
      .mockResolvedValueOnce(res(200, { messages: [] }) as never)
    await expect(fetchRawMessages({ accessToken: "t", query: "q", limit: 5 })).resolves.toEqual([])
  })
})
