import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReceipt,
  markSessionStart,
  readSessionMark,
  recordRead,
  recordRedirect,
  type SessionMark,
  type ReceiptInput,
} from "../src/engine/receipt.js";
import type { MeterReading } from "../src/engine/meter.js";
import type { ActivityEvent } from "../src/engine/activity.js";

const baseMeter = (over: Partial<MeterReading> = {}): MeterReading => ({
  usedTokens: 1000,
  windowTokens: 200_000,
  usedPct: 0.5,
  savedTokens: 0,
  optimizationPct: 0,
  estimated: false,
  cacheCold: false,
  status: "ok",
  advice: "",
  billingMode: "unknown",
  ...over,
});

const mark = (over: Partial<SessionMark> = {}): SessionMark => ({
  startTs: new Date().toISOString(),
  savedAtStart: 0,
  usedAtStart: 0,
  retrievalsAtStart: 0,
  reads: {},
  redirects: {},
  ...over,
});

const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({
  ts: new Date().toISOString(),
  agent: "a",
  tool: "t",
  summary: "s",
  saved: 0,
  ...over,
});

describe("buildReceipt — arithmetic + sink ordering", () => {
  it("sums consumed/avoided exactly and lists only the top-5 sinks by rawTokens desc", () => {
    const m = baseMeter({ savedTokens: 900, usedTokens: 100 });
    const sm = mark({ savedAtStart: 0, usedAtStart: 0, retrievalsAtStart: 0 });
    const events: ActivityEvent[] = [
      ev({ file: "a.ts", rawTokens: 100, storedTokens: 10 }),
      ev({ file: "b.ts", rawTokens: 90, storedTokens: 9 }),
      ev({ file: "c.ts", rawTokens: 80, storedTokens: 8 }),
      ev({ file: "d.ts", rawTokens: 70, storedTokens: 7 }),
      ev({ file: "e.ts", rawTokens: 60, storedTokens: 6 }),
      ev({ file: "smallest.ts", rawTokens: 10, storedTokens: 1 }),
    ];
    const input: ReceiptInput = { meter: m, mark: sm, events, eventsTrimmed: false, retrievalsTotal: 3 };
    const receipt = buildReceipt(input);

    // consumed = usedTokens - usedAtStart = 100; avoided = savedTokens - savedAtStart = 900
    expect(receipt).toContain("consumed ~100 tok · avoided 900 tok");
    // pct = round(900 / (100+900) * 100) = 90
    expect(receipt).toContain("(90% of what would have been)");

    for (const f of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) expect(receipt).toContain(f);
    expect(receipt).not.toContain("smallest.ts");

    // exact sink lines
    expect(receipt).toContain("a.ts: 100 → 10 tok (saved 90)");
    expect(receipt).toContain("e.ts: 60 → 6 tok (saved 54)");

    expect(receipt).toContain("3 exact recall(s) served byte-for-byte this session");
    expect(receipt).toContain("lifetime: 900 tok saved · 3 exact recalls");
  });
});

describe("buildReceipt — honest zero", () => {
  it("nothing happened this session → the no-claims sentence, no sinks/forecast", () => {
    const m = baseMeter({ savedTokens: 0, usedTokens: 500 });
    const sm = mark();
    const receipt = buildReceipt({ meter: m, mark: sm, events: [], eventsTrimmed: false, retrievalsTotal: 0 });
    expect(receipt).toContain("nothing was replaced or redirected, so nothing is claimed");
    expect(receipt).not.toContain("top sinks:");
    expect(receipt).not.toContain("at this pace the window lasts");
    expect(receipt).not.toContain("hygiene:");
  });
});

describe("buildReceipt — cap forecast", () => {
  it("plan billing + long session + avoided>0 → estimate line present", () => {
    const startTs = new Date(Date.now() - 20 * 60_000).toISOString(); // 20 min ago
    const m = baseMeter({ savedTokens: 500, usedTokens: 1000, billingMode: "plan", windowTokens: 200_000 });
    const sm = mark({ startTs });
    const receipt = buildReceipt({
      meter: m,
      mark: sm,
      events: [],
      eventsTrimmed: false,
      retrievalsTotal: 0,
      now: () => Date.now(),
    });
    expect(receipt).toContain("estimate");
  });

  it("api billing → no forecast line regardless of duration", () => {
    const startTs = new Date(Date.now() - 20 * 60_000).toISOString();
    const m = baseMeter({ savedTokens: 500, usedTokens: 1000, billingMode: "api" });
    const sm = mark({ startTs });
    const receipt = buildReceipt({ meter: m, mark: sm, events: [], eventsTrimmed: false, retrievalsTotal: 0 });
    expect(receipt).not.toContain("estimate");
    expect(receipt).not.toContain("at this pace the window lasts");
  });
});

describe("buildReceipt — no mark / lifetime labeling", () => {
  it("no session marker → the lifetime-labeled header", () => {
    const m = baseMeter({ savedTokens: 200, usedTokens: 50 });
    const receipt = buildReceipt({ meter: m, mark: null, events: [], eventsTrimmed: false, retrievalsTotal: 1 });
    expect(receipt).toContain("— knitbrain receipt (lifetime — no session marker) —");
  });
});

describe("buildReceipt — eventsTrimmed disclaimer", () => {
  it("eventsTrimmed=true → rotation disclaimer present", () => {
    const m = baseMeter({ savedTokens: 100, usedTokens: 10 });
    const sm = mark();
    const receipt = buildReceipt({ meter: m, mark: sm, events: [], eventsTrimmed: true, retrievalsTotal: 0 });
    expect(receipt).toContain("earliest events rotated out");
  });
});

describe("recordRead / recordRedirect", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-receipt-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("recordRead same path+mtime twice → count 2; different mtime → resets to 1", () => {
    markSessionStart(root, { savedTokens: 0, usedTokens: 0, retrievals: 0 });
    recordRead(root, "/proj/a.ts", 111);
    recordRead(root, "/proj/a.ts", 111);
    let m = readSessionMark(root)!;
    expect(m.reads["/proj/a.ts"]).toEqual({ count: 2, mtimeMs: 111 });

    recordRead(root, "/proj/a.ts", 222); // file changed → restart at 1
    m = readSessionMark(root)!;
    expect(m.reads["/proj/a.ts"]).toEqual({ count: 1, mtimeMs: 222 });
  });

  it("recordRedirect increments a per-path counter", () => {
    markSessionStart(root, { savedTokens: 0, usedTokens: 0, retrievals: 0 });
    recordRedirect(root, "/proj/big.ts");
    recordRedirect(root, "/proj/big.ts");
    const m = readSessionMark(root)!;
    expect(m.redirects["/proj/big.ts"]).toBe(2);
  });

  it("no session.json (fresh root, no mark) → record* are no-ops that don't throw", () => {
    expect(existsSync(join(root, "session.json"))).toBe(false);
    expect(() => recordRead(root, "/proj/a.ts", 1)).not.toThrow();
    expect(() => recordRedirect(root, "/proj/a.ts")).not.toThrow();
    expect(readSessionMark(root)).toBeNull();
  });
});

describe("G3 cold-restart waste line", () => {
  const meter = (over: Record<string, unknown> = {}) => ({
    usedTokens: 100_000, windowTokens: 1_000_000, usedPct: 10, savedTokens: 5_000,
    optimizationPct: 5, estimated: false, cacheCold: false, status: "ok" as const,
    advice: "", billingMode: "plan" as const, ...over,
  });
  const mark = { startTs: new Date(0).toISOString(), savedAtStart: 0, usedAtStart: 0, retrievalsAtStart: 0, reads: {}, redirects: {} };
  const ev = (tsMs: number) => ({ ts: new Date(tsMs).toISOString(), agent: "x", tool: "t", summary: "s", saved: 100, rawTokens: 200, storedTokens: 100 });

  it("names cold gaps >5min between session events, labeled estimate", async () => {
    const { buildReceipt } = await import("../src/engine/receipt.js");
    const r = buildReceipt({ meter: meter(), mark, events: [ev(0), ev(6 * 60_000), ev(7 * 60_000), ev(20 * 60_000)], eventsTrimmed: false, retrievalsTotal: 0 });
    expect(r).toContain("2 idle gap(s) >5min");
    expect(r).toContain("estimate");
  });

  it("stays silent when no gap exceeds the cache TTL", async () => {
    const { buildReceipt } = await import("../src/engine/receipt.js");
    const r = buildReceipt({ meter: meter(), mark, events: [ev(0), ev(60_000), ev(120_000)], eventsTrimmed: false, retrievalsTotal: 0 });
    expect(r).not.toContain("idle gap");
  });
});

describe("G5 dollar conversion (api-billing only)", () => {
  const meter = (over: Record<string, unknown> = {}) => ({
    usedTokens: 100_000, windowTokens: 1_000_000, usedPct: 10, savedTokens: 2_000_000,
    optimizationPct: 5, estimated: false, cacheCold: false, status: "ok" as const,
    advice: "", billingMode: "api" as const, model: "claude-sonnet-5", ...over,
  });
  const mark = { startTs: new Date(0).toISOString(), savedAtStart: 0, usedAtStart: 0, retrievalsAtStart: 0, reads: {}, redirects: {} };
  const base = { mark, events: [], eventsTrimmed: false, retrievalsTotal: 0 };

  it("api + known model → exact $ arithmetic, labeled estimate (2M tok @ $3/MTok = $6.00)", async () => {
    const { buildReceipt } = await import("../src/engine/receipt.js");
    const r = buildReceipt({ meter: meter(), ...base });
    expect(r).toContain("$6.00");
    expect(r).toContain("estimate");
  });

  it("plan billing → NO dollars ever", async () => {
    const { buildReceipt } = await import("../src/engine/receipt.js");
    const r = buildReceipt({ meter: meter({ billingMode: "plan" }), ...base });
    expect(r).not.toContain("$");
  });

  it("api + unknown model → no $ line", async () => {
    const { buildReceipt } = await import("../src/engine/receipt.js");
    const r = buildReceipt({ meter: meter({ model: "mystery-llm-9000" }), ...base });
    expect(r).not.toContain("$");
  });
});
