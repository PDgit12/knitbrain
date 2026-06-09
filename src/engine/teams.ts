import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CCRStore } from "../ccr/store.js";
import { compress } from "../optimizer/router.js";

/** One posting on the shared board: a compressed skeleton + a CCR handle to the full original. */
export interface BoardEntry {
  id: string;
  author: string;
  /** Compressed/skeleton view (cheap for other agents to read). */
  summary: string;
  /** CCR handle to the pristine original. */
  handle: string;
  ts: string;
}

export interface TeamBoard {
  /** Post a finding: store the full original in CCR, keep a compressed summary on the board. */
  post(author: string, content: string): BoardEntry;
  /** The shared board — skeletons only (page originals via get). */
  board(): BoardEntry[];
  /** Fetch the full original of an entry by id (byte-for-byte from CCR). */
  get(id: string): string | null;
  /** Clear the board (entries only; CCR originals remain until tiered out). */
  clear(): void;
}

/**
 * Shared compressed-context board. Parallel agents post findings as skeletons
 * (cheap for everyone to read); the full original is one CCR lookup away. This
 * is what makes N parallel agents NOT multiply context cost. Local-first; the
 * networked multi-user hub builds on top of this later.
 */
export function createTeamBoard(root: string, ccr: CCRStore): TeamBoard {
  mkdirSync(root, { recursive: true });
  const path = join(root, "board.json");

  const load = (): BoardEntry[] => {
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, "utf8")) as BoardEntry[];
    } catch {
      return [];
    }
  };
  const save = (entries: BoardEntry[]): void => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf8");
    renameSync(tmp, path);
  };

  return {
    post(author, content) {
      const r = compress(content, ccr);
      // Always keep the pristine original recoverable, compressed or not.
      const handle = r.compressed ? r.handle : ccr.put(content);
      const entry: BoardEntry = {
        id: createHash("sha256").update(author + content + Date.now()).digest("hex").slice(0, 8),
        author,
        summary: r.compressed ? r.skeleton : content,
        handle,
        ts: new Date().toISOString(),
      };
      save([...load(), entry]);
      return entry;
    },
    board() {
      return load();
    },
    get(id) {
      const entry = load().find((e) => e.id === id);
      if (!entry) return null;
      return ccr.get(entry.handle);
    },
    clear() {
      save([]);
    },
  };
}
