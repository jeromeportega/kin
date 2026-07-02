// Deterministic Gmail deep-links — no model involved, so these are validated by
// unit tests on the URL shape (see gmailLinks.test.ts), not the classifier eval.

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
