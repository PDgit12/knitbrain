import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledge } from "../src/engine/knowledge.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});
const roots: string[] = [];
afterEach(() => {
  vi.mocked(fs.readdirSync).mockRestore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kb-scan-resilience-"));
  roots.push(root);
  mkdirSync(join(root, "blocked"));
  writeFileSync(join(root, "good.ts"), "export const survives = 1;");
  return { root, knowledge: createKnowledge(root, join(root, ".cache")) };
}
describe("scan filesystem failures", () => {
  it.each(["EPERM", "EACCES", "ENOENT"])("keeps readable files when a child returns %s", (code) => {
    const { root, knowledge } = fixture();
    const real = vi.mocked(fs.readdirSync).getMockImplementation()! as unknown as (path: string) => string[];
    vi.mocked(fs.readdirSync).mockImplementation(((path: string) => {
      if (String(path) === join(root, "blocked")) throw Object.assign(new Error("blocked"), { code });
      return real(path);
    }) as unknown as typeof fs.readdirSync);
    expect(knowledge.scan().files).toBe(1);
    expect(knowledge.queryExports("good.ts")).toEqual(["survives"]);
  });
  it("does not follow a symlink cycle or index outside the project", () => {
    const { root, knowledge } = fixture();
    symlinkSync(root, join(root, "cycle"));
    expect(knowledge.scan().files).toBe(1);
  });
  it("reports an inaccessible root instead of an empty successful index", () => {
    const { knowledge } = fixture();
    vi.mocked(fs.readdirSync).mockImplementationOnce(() => { throw Object.assign(new Error("root blocked"), { code: "EPERM" }); });
    expect(() => knowledge.scan()).toThrow("root blocked");
  });
  it("does not hide unexpected disk failures", () => {
    const { knowledge } = fixture();
    vi.mocked(fs.readdirSync).mockImplementationOnce(() => { throw Object.assign(new Error("disk failure"), { code: "EIO" }); });
    expect(() => knowledge.scan()).toThrow("disk failure");
  });
});
