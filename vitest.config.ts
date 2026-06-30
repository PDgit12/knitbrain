import { defineConfig } from "vitest/config";

// Default the adherence strictness to "off" for the unit suite: most tests
// dispatch close-the-loop writes (record_learning/save_handoff) without first
// classifying, because they're testing those tools, not the gate. The gate's
// own matrix lives in tests/adherence.test.ts, which sets KNITBRAIN_STRICTNESS
// explicitly per case. The product default (block) is unchanged and proven by
// that test + the e2e/production-audit harnesses.
export default defineConfig({
  test: {
    setupFiles: ["./tests/_setup-env.ts"],
  },
});
