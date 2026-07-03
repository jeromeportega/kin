import { describe, it, expect } from "vitest"
import { gmailSearchUrl, gmailComposeUrl, googleCalendarUrl } from "@/lib/gmailLinks"

describe("googleCalendarUrl", () => {
  it("builds an all-day event link (end exclusive → +1 day)", () => {
    const url = googleCalendarUrl({ title: "Property tax due", start: "2026-07-10", end: null })
    expect(url).toContain("action=TEMPLATE")
    expect(url).toContain("text=Property+tax+due")
    expect(url).toContain("dates=20260710%2F20260711")
  })
  it("builds a timed event link with a default 1h duration", () => {
    const url = googleCalendarUrl({
      title: "Dentist",
      start: "2026-07-10T14:00:00+00:00",
      end: null,
    })
    expect(url).toContain("dates=20260710T140000Z%2F20260710T150000Z")
  })
})

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
