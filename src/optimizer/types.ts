/** Content categories the router can detect and the handlers produce. */
export type ContentType = "json" | "code" | "text";

/** Output of compressing one payload: the skeleton view + its CCR handle. */
export interface CompressResult {
  /** The compressed, still-readable skeleton (carries the ⟨ccr:…⟩ handle). */
  readonly skeleton: string;
  /** Full CCR handle for byte-for-byte recovery of the original. */
  readonly handle: string;
  /** Detected content type. */
  readonly contentType: ContentType;
}
