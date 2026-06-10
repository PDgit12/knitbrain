import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Server } from "node:http";
import { createFileCCRStore, CCRMissingError, type CCRStore } from "../src/ccr/store.js";
import { writeAgent } from "../src/engine/agents.js";
import { createHub } from "../src/hub/server.js";

const listen = (s: Server): Promise<number> =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));

describe("security regressions", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-sec-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe("CCR path traversal", () => {
    let ccr: CCRStore;
    beforeEach(() => {
      ccr = createFileCCRStore(join(root, "ccr"));
      // a juicy file OUTSIDE the store that traversal would reach
      writeFileSync(join(root, "secret.txt"), "top secret");
    });

    it("get() rejects non-hex handles before touching the filesystem", () => {
      expect(() => ccr.get("../secret.txt")).toThrow(CCRMissingError);
      expect(() => ccr.get("..%2F..%2Fetc%2Fpasswd")).toThrow(CCRMissingError);
      expect(() => ccr.get("")).toThrow(CCRMissingError);
    });

    it("has()/tierOf() cannot be used to probe arbitrary file existence", () => {
      expect(ccr.has("../secret.txt")).toBe(false);
      expect(ccr.tierOf("../secret.txt")).toBe("absent");
    });

    it("demote()/promote() ignore malicious handles", () => {
      expect(() => ccr.demote("../secret.txt")).not.toThrow();
      expect(() => ccr.promote("../secret.txt")).not.toThrow();
      expect(existsSync(join(root, "secret.txt"))).toBe(true); // untouched
    });

    it("valid handles still work normally", () => {
      const h = ccr.put("legit content");
      expect(ccr.get(h)).toBe("legit content");
    });
  });

  describe("agent name traversal", () => {
    it("sanitizes path separators out of agent names", () => {
      const path = writeAgent(root, { name: "../../evil" });
      expect(path).toContain(join(".claude", "agents"));
      expect(path).not.toContain("..");
      expect(existsSync(join(root, ".claude", "agents", "evil.md"))).toBe(true);
      expect(existsSync(join(root, "..", "evil.md"))).toBe(false);
    });

    it("rejects names that sanitize to nothing", () => {
      expect(() => writeAgent(root, { name: "../.." })).toThrow(/invalid agent name/);
    });
  });

  describe("hub auth hardening", () => {
    it("rejects missing/short/wrong tokens (constant-time compare path)", async () => {
      const { server, token } = createHub(join(root, "hub"));
      try {
        const url = `http://127.0.0.1:${await listen(server)}`;
        expect((await fetch(`${url}/board`)).status).toBe(401);
        expect((await fetch(`${url}/board`, { headers: { authorization: "Bearer x" } })).status).toBe(401);
        expect(
          (await fetch(`${url}/board`, { headers: { authorization: `Bearer ${token}` } })).status,
        ).toBe(200);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });
});
