import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

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

/** Obvious credential shapes. A board original is stored byte-exact for the
 * team, so we REJECT (never silently scrub — that would corrupt the original)
 * a posting that looks like it carries a live secret. Defense-in-depth, not a
 * guarantee: posters still must not paste secrets. */
const SECRET_RE = /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;

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

export function createHub(root: string): Hub {
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
        if (SECRET_RE.test(body.original) || SECRET_RE.test(body.summary ?? "")) {
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
