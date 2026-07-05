import { describe, it, expect, afterEach } from "vitest";
import { scrubSecrets, cleanseForBrain } from "../src/engine/cleanse.js";

describe("cleanse: scrubSecrets — credentials never enter the brain", () => {
  it("redacts common credential shapes", () => {
    expect(scrubSecrets("key is sk-ant-api03-abcdefghij1234567890XYZ")).toContain("[REDACTED:ANTHROPIC-KEY]");
    expect(scrubSecrets("openai sk-abcdefghijklmnop1234567890")).toContain("[REDACTED:OPENAI-KEY]");
    expect(scrubSecrets("token ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toContain("[REDACTED:GITHUB-TOKEN]");
    expect(scrubSecrets("aws AKIAIOSFODNN7EXAMPLE here")).toContain("[REDACTED:AWS-KEY]");
    expect(scrubSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toContain("[REDACTED:BEARER-TOKEN]");
    expect(scrubSecrets('api_key="supersecretvalue1234"')).toContain("[REDACTED:CREDENTIAL]");
  });

  it("redacts a private-key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc123\n-----END RSA PRIVATE KEY-----";
    const out = scrubSecrets(`leaked:\n${pem}`);
    expect(out).toContain("[REDACTED:PRIVATE-KEY]");
    expect(out).not.toContain("MIIabc123");
  });

  it("leaves ordinary prose untouched (no false positives)", () => {
    const prose = "The meter probes the transcript model to derive the real window.";
    expect(scrubSecrets(prose)).toBe(prose);
  });
});

describe("cleanse: cleanseForBrain — scrub + terse together", () => {
  afterEach(() => { delete process.env["KNITBRAIN_TERSE_STORE"]; });

  it("scrubs a secret AND terses filler (default-on terse)", () => {
    const out = cleanseForBrain("Please just use the token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here");
    expect(out).toContain("[REDACTED:GITHUB-TOKEN]");
    expect(out).not.toMatch(/\bplease\b/i); // pleasantry dropped
    expect(out).not.toMatch(/\bjust\b/i); // filler dropped
  });

  it("KNITBRAIN_TERSE_STORE=0 keeps prose verbatim but STILL scrubs secrets", () => {
    process.env["KNITBRAIN_TERSE_STORE"] = "0";
    const out = cleanseForBrain("Please keep the AKIAIOSFODNN7EXAMPLE safe");
    expect(out).toContain("[REDACTED:AWS-KEY]");
    expect(out).toContain("Please keep"); // terse off → filler stays
  });

  it("preserves code, paths, and numbers (technical substance survives terse)", () => {
    const out = cleanseForBrain("the fix is in `src/engine/meter.ts` at line 188 with the value 200000");
    expect(out).toContain("`src/engine/meter.ts`");
    expect(out).toContain("200000");
    expect(out).toContain("188");
  });
});
