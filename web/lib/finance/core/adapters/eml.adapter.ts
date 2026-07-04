import type { ImportError, NormalizedBatch, RawInput, SourceAdapter } from './source-adapter';
import { parseMimeMessage } from './eml/mime';
import { matchParser } from './eml/dispatch';

/**
 * `.eml` source adapter (FR-9 / epic-007).
 *
 * `supports()` returns true iff the input is an `eml` kind AND at least one
 * registered retailer parser claims to recognise the bytes.
 *
 * `normalize()` dispatches to the matched retailer parser; an unrecognised or
 * unparseable email is silently skipped (returns an empty batch with an
 * ImportError entry) — never throws (ADR-001).
 *
 * Zero network or credential access happens inside this adapter (NFR-1).
 */
export const emlAdapter: SourceAdapter = {
  kind: 'eml',

  supports(input: RawInput): boolean {
    if (input.kind !== 'eml') return false;
    try {
      const msg = parseMimeMessage(input.bytes, input.filename);
      return matchParser(msg) !== null;
    } catch {
      return false;
    }
  },

  normalize(input: RawInput): NormalizedBatch {
    const errors: ImportError[] = [];

    let msg;
    try {
      msg = parseMimeMessage(input.bytes, input.filename);
    } catch (err) {
      errors.push({
        rowRef: input.filename,
        reason: `MIME parse error: ${err instanceof Error ? err.message : String(err)}`,
        raw: null,
      });
      return { transactions: [], orders: [], receipts: [], errors };
    }

    const parser = matchParser(msg);
    if (!parser) {
      errors.push({
        rowRef: input.filename,
        reason: 'No retailer parser matched this email',
        raw: { from: msg.from, subject: msg.subject },
      });
      return { transactions: [], orders: [], receipts: [], errors };
    }

    try {
      const order = parser.parse(msg);
      return { transactions: [], orders: [order], receipts: [], errors };
    } catch (err) {
      errors.push({
        rowRef: input.filename,
        reason: `Parse error (${parser.retailer}): ${err instanceof Error ? err.message : String(err)}`,
        raw: { from: msg.from, subject: msg.subject },
      });
      return { transactions: [], orders: [], receipts: [], errors };
    }
  },
};
