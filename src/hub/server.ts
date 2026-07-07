import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { containsSecret } from "../engine/cleanse.js";
import { writeAtomic } from "../atomic.js";

/**
 * Knit Brain HUB — the shared-sessions server a team points at.
 * One URL + one token; everything else is invisible. Clients mirror their
 * board postings here fire-and-forget; dashboards read the merged view.
 * Auth: single team token (Bearer). Originals stored verbatim server-side so
 * any teammate can page in the full content (their local CCR handles don't
 * resolve across machines).
 */
export interface HubEntry {
  id: string;
  author: string;
  /** Compressed skeleton (cheap for everyone to scan). */
  summary: string;
  /** Full original (recoverable by any teammate). */
  original: string;
  ts: string;
}

export interface Hub {
  server: Server;
  token: string;
}

/** Cap request bodies so one authenticated client can't exhaust hub memory. */
const MAX_BODY_BYTES = 1_000_000;

/** Default fixed-window rate limit: 60 req / 10s per remote address. */
const DEFAULT_RATE_LIMIT = { max: 60, windowMs: 10_000 };

/** Default board size cap (entries) before the rare rewrite-to-newest-N kicks in. */
const MAX_BOARD_ENTRIES = 500;

/** Bound the rate-limit address map itself — a botnet of distinct IPs must not grow this unbounded. */
const MAX_RATE_LIMIT_ENTRIES = 1000;

// Credential detection shared with the brain-write cleanse (single source in
// engine/cleanse.ts). A board original is stored byte-exact for the team, so we
// REJECT (never silently scrub — that would corrupt the original) a posting that
// looks like it carries a live secret. Defense-in-depth, not a guarantee.

/** Sentinel returned (not thrown) when a body exceeds the cap, so the handler
 * can answer with a clean 413 instead of resetting the socket. */
const TOO_LARGE = Symbol("too-large");

function readBody(req: IncomingMessage): Promise<string | typeof TOO_LARGE> {
  return new Promise((resolve, reject) => {
    let d = "";
    let bytes = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        over = true; // stop buffering, keep draining (bounded memory)
        return;
      }
      if (!over) d += c;
    });
    req.on("end", () => resolve(over ? TOO_LARGE : d));
    req.on("error", reject);
  });
}

export function createHub(
  root: string,
  opts?: { now?: () => number; rateLimit?: { max: number; windowMs: number }; maxEntries?: number },
): Hub {
  const now = opts?.now ?? Date.now;
  const rateLimit = opts?.rateLimit ?? DEFAULT_RATE_LIMIT;
  const maxEntries = opts?.maxEntries ?? MAX_BOARD_ENTRIES;
  mkdirSync(root, { recursive: true });
  const tokenPath = join(root, "token.txt");
  // Append-only log: one JSON entry per line. Posting is O(1) (append a line)
  // instead of O(N) (rewrite the whole board) — so a sprint's worth of team
  // postings doesn't degrade to O(N²) total. Legacy board.json is migrated in.
  const boardPath = join(root, "board.jsonl");
  const legacyPath = join(root, "board.json");

  let token: string;
  if (existsSync(tokenPath)) {
    token = readFileSync(tokenPath, "utf8").trim();
  } else {
    token = `khub_${randomBytes(24).toString("hex")}`;
    writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  }

  // One-time migration from the old whole-file board.json to the JSONL log.
  if (!existsSync(boardPath) && existsSync(legacyPath)) {
    try {
      const old = JSON.parse(readFileSync(legacyPath, "utf8")) as HubEntry[];
      if (old.length > 0) writeFileSync(boardPath, old.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    } catch {
      /* corrupt legacy board — start fresh */
    }
  }

  const load = (): HubEntry[] => {
    if (!existsSync(boardPath)) return [];
    const out: HubEntry[] = [];
    for (const line of readFileSync(boardPath, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as HubEntry);
      } catch {
        /* skip a corrupt line, keep the rest */
      }
    }
    return out;
  };
  const append = (entry: HubEntry): void => {
    writeFileSync(boardPath, JSON.stringify(entry) + "\n", { encoding: "utf8", flag: "a" });
  };
  // Sole write-amplification point: appends are O(1), but once the log passes
  // maxEntries we rewrite it down to the newest maxEntries (rare — only at cap).
  const trimBoard = (): void => {
    const all = load();
    if (all.length <= maxEntries) return;
    const kept = all.slice(all.length - maxEntries);
    writeAtomic(boardPath, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
  };

  // Fixed-window rate limiter, per remote address. Map insertion order gives
  // us oldest-inserted-first eviction for free (bounded regardless of window
  // resets) — a simple Map, not an LRU, since we only ever need "oldest key".
  const rateBuckets = new Map<string, { windowStart: number; count: number }>();
  const rateLimited = (addr: string): boolean => {
    const t = now();
    let bucket = rateBuckets.get(addr);
    if (!bucket || t - bucket.windowStart >= rateLimit.windowMs) {
      bucket = { windowStart: t, count: 0 };
      rateBuckets.delete(addr); // re-insert at the end (fresh window = fresh recency)
      rateBuckets.set(addr, bucket);
    }
    bucket.count++;
    if (rateBuckets.size > MAX_RATE_LIMIT_ENTRIES) {
      const oldestKey = rateBuckets.keys().next().value;
      if (oldestKey !== undefined) rateBuckets.delete(oldestKey);
    }
    return bucket.count > rateLimit.max;
  };

  // SECURITY: constant-time comparison — no timing oracle on the team token.
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const authed = (req: IncomingMessage): boolean => {
    const got = createHash("sha256").update(req.headers.authorization ?? "").digest();
    return timingSafeEqual(got, expected);
  };

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/health") {
        return json(res, 200, { status: "healthy", server: "knitbrain-hub" });
      }
      if (rateLimited(req.socket.remoteAddress ?? "?")) {
        return json(res, 429, { error: "rate-limited" });
      }
      if (!authed(req)) return json(res, 401, { error: "missing or invalid token" });

      if (req.method === "POST" && req.url === "/board") {
        const raw = await readBody(req);
        if (raw === TOO_LARGE) return json(res, 413, { error: "body too large" });
        let body: Partial<HubEntry>;
        try {
          body = JSON.parse(raw) as Partial<HubEntry>;
        } catch {
          return json(res, 400, { error: "invalid JSON body" });
        }
        if (typeof body.author !== "string" || typeof body.original !== "string") {
          return json(res, 400, { error: "author and original are required" });
        }
        if (containsSecret(body.original) || containsSecret(body.summary ?? "")) {
          return json(res, 400, { error: "posting looks like it contains a secret — redact before posting" });
        }
        const entry: HubEntry = {
          id: createHash("sha256").update(body.author + body.original + Date.now()).digest("hex").slice(0, 8),
          author: body.author,
          summary: typeof body.summary === "string" ? body.summary : body.original.slice(0, 400),
          original: body.original,
          ts: new Date().toISOString(),
        };
        append(entry);
        trimBoard();
        return json(res, 200, { id: entry.id });
      }
      if (req.method === "GET" && req.url === "/board") {
        return json(res, 200, load().map((e) => ({ id: e.id, author: e.author, summary: e.summary, ts: e.ts })));
      }
      const m = req.url?.match(/^\/board\/([0-9a-f]{8})$/);
      if (req.method === "GET" && m) {
        const entry = load().find((e) => e.id === m[1]);
        return entry ? json(res, 200, entry) : json(res, 404, { error: "not found" });
      }
      return json(res, 404, { error: "not found" });
    })().catch(() => json(res, 500, { error: "internal error" })); // never leak err detail
  });

  return { server, token };
}
