import type { ParsedEmailMessage, RetailerEmailParser } from './types';
import { amazonEmailParser } from './parsers/amazon';

/** All registered retailer parsers. Adding a new retailer = append here only. */
const PARSERS: RetailerEmailParser[] = [amazonEmailParser];

/**
 * Return the first parser that claims the message, or `null` if no parser matches.
 * This is the dispatch seam (FR-9): a new retailer parser can be registered above
 * without changing the adapter's public contract or the batch model.
 */
export function matchParser(msg: ParsedEmailMessage): RetailerEmailParser | null {
  return PARSERS.find((p) => p.matches(msg)) ?? null;
}

/**
 * Return a Gmail search query that covers every registered parser's fetch filter.
 * The route calls this to stay retailer-agnostic — adding a parser automatically
 * widens the query.
 */
export function emlGmailQuery(): string {
  return PARSERS.map((p) => `(${p.gmailQuery})`).join(' OR ');
}
