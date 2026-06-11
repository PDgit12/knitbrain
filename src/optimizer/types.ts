/** Content categories the router can detect and the handlers produce.
 * "prose" is produced (not detected): short prose that took the sentence
 * anchor — its own TOIN kind so over-retrieval backs it off independently.
 * "search" / "log" / "diff" are structured shapes with dedicated handlers
 * (detected before the looser code heuristic). */
export type ContentType = "json" | "code" | "text" | "prose" | "search" | "log" | "diff";

/** Output of compressing one payload: the skeleton view + its CCR handle. */
export interface CompressResult {
  /** The compressed, still-readable skeleton (carries the ⟨ccr:…⟩ handle). */
  readonly skeleton: string;
  /** Full CCR handle for byte-for-byte recovery of the original. */
  readonly handle: string;
  /** Detected content type. */
  readonly contentType: ContentType;
}
