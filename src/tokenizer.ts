import { encode } from "gpt-tokenizer/encoding/o200k_base";

/**
 * Token counting interface — deliberately tiny and swappable.
 *
 * The active implementation uses `gpt-tokenizer` with the `o200k_base`
 * encoding (modern GPT-4o family): pure-JS, zero native deps, fast. Since
 * Knit Brain's headline metric is the compression *ratio* (before ÷ after),
 * the absolute count being an approximation of any one provider's tokenizer
 * does not distort results — as long as one consistent tokenizer is used.
 */
export interface Tokenizer {
  /** Encoding identifier, surfaced in metrics for reproducibility. */
  readonly name: string;
  /** Count tokens in a string. Empty string is 0 tokens. */
  count(text: string): number;
}

/** Default tokenizer: gpt-tokenizer, o200k_base encoding. */
export const o200kTokenizer: Tokenizer = {
  name: "o200k_base",
  count(text: string): number {
    if (text.length === 0) return 0;
    return encode(text).length;
  },
};

/** The active tokenizer. Swap here (or via setTokenizer) to change encodings. */
let active: Tokenizer = o200kTokenizer;

/** Override the active tokenizer (e.g. in tests or for a different encoding). */
// ts-prune-ignore-next — intentional encoding-override knob; the only seam to swap tokenizers
export function setTokenizer(tokenizer: Tokenizer): void {
  active = tokenizer;
}

/** Token count using the active tokenizer. */
export function countTokens(text: string): number {
  return active.count(text);
}

/** Name of the active tokenizer's encoding. */
export function activeTokenizerName(): string {
  return active.name;
}
