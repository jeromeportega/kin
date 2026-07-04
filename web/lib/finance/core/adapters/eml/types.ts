import type { NormalizedOrder } from '../../model/normalized';

export interface ParsedEmailMessage {
  from: string;
  subject: string;
  html: string;
  text: string;
  /** == RawInput.filename: the stable Gmail message id */
  messageId: string;
}

export interface RetailerEmailParser {
  readonly retailer: 'amazon';
  readonly gmailQuery: string;
  matches(msg: ParsedEmailMessage): boolean;
  /** Throws only on truly malformed input; the adapter caller catches and records ImportError. */
  parse(msg: ParsedEmailMessage): NormalizedOrder;
}
