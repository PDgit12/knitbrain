import { createFileCCRStore, type CCRStore } from "./ccr/store.js";
import { compress as routeCompress, type RouteResult, type CompressOptions } from "./optimizer/router.js";
import { ensureAst } from "./optimizer/ast.js";
import { ccrRoot } from "./paths.js";
import { countTokens } from "./tokenizer.js";

/**
 * Public library API — use knitbrain inline, no proxy or MCP required.
 *
 * ```ts
 * import { createOptimizer } from "knitbrain";
 * const kb = createOptimizer();
 * const r = kb.compress(bigToolOutput);
 * // r.skeleton  → hand to the model
 * // kb.retrieve(r.handle) → exact original, byte-for-byte
 * ```
 *
 * Same router as the proxy and MCP server: detect → route → compress, with
 * the never-expand guard and lossless CCR recovery. Originals live under
 * `~/.knitbrain/ccr` unless `root` is given.
 */
export interface Optimizer {
  /** Compress one payload. Lossless: original recoverable via retrieve(). */
  compress(text: string, options?: CompressOptions): RouteResult;
  /** Exact original for a handle a skeleton referenced. Throws if absent. */
  retrieve(handle: string): string;
  /** Whether a handle is still recoverable. */
  has(handle: string): boolean;
  /** Resolves when the tree-sitter AST parsers are warm (optional — the
   * scanner fallback serves code until then). */
  ready(): Promise<void>;
}

export interface OptimizerOptions {
  /** CCR storage directory (default: `~/.knitbrain/ccr`). */
  root?: string;
}

export function createOptimizer(options: OptimizerOptions = {}): Optimizer {
  const store: CCRStore = createFileCCRStore(options.root ?? ccrRoot());
  void ensureAst(); // warm the WASM parsers in the background
  return {
    compress: (text, opts) => routeCompress(text, store, opts),
    retrieve: (handle) => store.get(handle),
    has: (handle) => store.has(handle),
    ready: () => ensureAst(),
  };
}

export { countTokens };
export type { RouteResult, CompressOptions, CCRStore };
// ts-prune-ignore-next — public API type for package consumers (no internal importer by design)
export type { ContentType } from "./optimizer/types.js";
