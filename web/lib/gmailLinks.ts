import type { CalendarEvent } from "./types"

// Deterministic Gmail / Google Calendar deep-links — no model involved, so these
// are validated by unit tests on the URL shape (see gmailLinks.test.ts).

/** Build a Google Calendar "add event" link from an extracted event. */
export function googleCalendarUrl(event: CalendarEvent): string {
  const timed = event.start.includes("T")
  const toMs = (iso: string) => Date.parse(iso.includes("T") ? iso : `${iso}T00:00:00Z`)
  const startMs = toMs(event.start)
  // Default duration when no end is given: 1 hour (timed) or 1 day (all-day).
  // Google treats an all-day end as exclusive, so a stated all-day end gets +1 day.
  const endMs = event.end
    ? toMs(event.end) + (timed ? 0 : 86_400_000)
    : startMs + (timed ? 3_600_000 : 86_400_000)

  const stamp = (ms: number) =>
    timed
      ? new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
      : new Date(ms).toISOString().slice(0, 10).replace(/-/g, "")

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${stamp(startMs)}/${stamp(endMs)}`,
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

/**
 * Open a specific message in Gmail by its RFC822 Message-ID. Gmail has no public
 * "open message by id" URL, so we use its message-id search operator, which lands
 * on the single matching thread.
 */
export function gmailSearchUrl(messageId: string): string {
  const id = messageId.replace(/[<>]/g, "").trim()
  const query = `rfc822msgid:${id}`
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`
}

/** Prefix "Re: " unless the subject already has one. */
function replySubject(subject: string): string {
  const s = subject.trim()
  return /^re:/i.test(s) ? s : `Re: ${s}`
}

/**
 * Open Gmail's compose window pre-filled to reply to a sender. Just opens the
 * composer (view=cm) — it does NOT send, so it needs no Gmail write scope.
 */
export function gmailComposeUrl(opts: { to: string; subject: string; body?: string }): string {
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to: opts.to,
    su: replySubject(opts.subject),
  })
  if (opts.body) params.set("body", opts.body)
  return `https://mail.google.com/mail/?${params.toString()}`
}
