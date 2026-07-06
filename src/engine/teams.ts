import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { writeAtomic } from "../atomic.js";
import { join } from "node:path";
import type { CCRStore } from "../ccr/store.js";
import { compress } from "../optimizer/router.js";
import { scrubSecrets } from "./cleanse.js";

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
    writeAtomic(path, JSON.stringify(entries, null, 2));
  };

  return {
    post(author, rawContent) {
      // H2: scrub secrets at the storage layer so EVERY caller (MCP tool, hub,
      // a direct engine call) is protected — a pasted key never enters the
      // board, the CCR original, or a hub mirror. Defense-in-depth with the
      // tool-layer scrub. Matches wiki.ingest's cleanse-on-write.
      const content = scrubSecrets(rawContent);
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
      // M6: two agents posting concurrently each load N and write N+1, silently
      // dropping one — the exact "N parallel agents" case the board exists for.
      // Reload immediately before the write and retry while the file keeps
      // changing under us; merge by id so a retry re-picks-up a rival's entry
      // instead of clobbering it. Narrows the lost-update window to the atomic
      // write itself. (A single-writer lock would fully close it; the board is
      // best-effort shared context, so a bounded CAS is the right tradeoff.)
      const mtime = (): number => {
        try {
          return statSync(path).mtimeMs;
        } catch {
          return 0;
        }
      };
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const before = mtime();
        const byId = new Map<string, BoardEntry>();
        for (const e of load()) byId.set(e.id, e);
        byId.set(entry.id, entry);
        save([...byId.values()]);
        if (mtime() === before) break; // nobody wrote between our load and save
      }
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
