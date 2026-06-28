import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

import { mintAccessToken, ReauthRequired, stripHtml, decodeB64Url, fetchRecent } from "@/lib/gmail"

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
