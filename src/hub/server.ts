import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}

export function createHub(root: string): Hub {
  mkdirSync(root, { recursive: true });
  const tokenPath = join(root, "token.txt");
  const boardPath = join(root, "board.json");

  let token: string;
  if (existsSync(tokenPath)) {
    token = readFileSync(tokenPath, "utf8").trim();
  } else {
    token = `khub_${randomBytes(24).toString("hex")}`;
    writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  }

  const load = (): HubEntry[] => {
    if (!existsSync(boardPath)) return [];
    try {
      return JSON.parse(readFileSync(boardPath, "utf8")) as HubEntry[];
    } catch {
      return [];
    }
  };
  const save = (entries: HubEntry[]): void => {
    const tmp = `${boardPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), "utf8");
    renameSync(tmp, boardPath);
  };

  const authed = (req: IncomingMessage): boolean =>
    req.headers.authorization === `Bearer ${token}`;

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
        const body = JSON.parse(await readBody(req)) as Partial<HubEntry>;
        if (typeof body.author !== "string" || typeof body.original !== "string") {
          return json(res, 400, { error: "author and original are required" });
        }
        const entry: HubEntry = {
          id: createHash("sha256").update(body.author + body.original + Date.now()).digest("hex").slice(0, 8),
          author: body.author,
          summary: typeof body.summary === "string" ? body.summary : body.original.slice(0, 400),
          original: body.original,
          ts: new Date().toISOString(),
        };
        save([...load(), entry]);
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
    })().catch((err: unknown) => json(res, 500, { error: String(err) }));
  });

  return { server, token };
}
