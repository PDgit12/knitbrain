// Unit suite runs with the adherence gate OFF by default (see vitest.config.ts).
// tests/adherence.test.ts opts back into warn/block per case and restores this.
if (process.env["KNITBRAIN_STRICTNESS"] === undefined) {
  process.env["KNITBRAIN_STRICTNESS"] = "off";
}
