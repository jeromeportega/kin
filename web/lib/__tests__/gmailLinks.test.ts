import { describe, it, expect } from "vitest"
import { gmailSearchUrl, gmailComposeUrl } from "@/lib/gmailLinks"

describe("gmailSearchUrl", () => {
  it("strips angle brackets and encodes the rfc822msgid query", () => {
    const url = gmailSearchUrl("<CABc123@mail.gmail.com>")
    expect(url).toBe(
      "https://mail.google.com/mail/u/0/#search/rfc822msgid%3ACABc123%40mail.gmail.com"
    )
  })
  it("handles an id without angle brackets", () => {
    expect(gmailSearchUrl("abc@x.com")).toContain("rfc822msgid%3Aabc%40x.com")
  })
})

describe("gmailComposeUrl", () => {
  it("builds a compose link with to + Re: subject", () => {
    const url = gmailComposeUrl({ to: "jane@x.com", subject: "Interview" })
    expect(url).toContain("view=cm")
    expect(url).toContain("to=jane%40x.com")
    expect(url).toContain("su=Re%3A+Interview")
    expect(url).not.toContain("body=")
  })
  it("does not double-prefix an existing Re:", () => {
    expect(gmailComposeUrl({ to: "j@x.com", subject: "Re: Hi" })).toContain("su=Re%3A+Hi")
  })
  it("includes the body when provided", () => {
    expect(gmailComposeUrl({ to: "j@x.com", subject: "Hi", body: "Thanks!" })).toContain(
      "body=Thanks%21"
    )
  })
})
