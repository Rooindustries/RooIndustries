const fs = require("node:fs");
const path = require("node:path");

module.exports = async () => {
  const { localOrigin } = await import("../../scripts/lib/test-target-safety.mjs");
  const base = localOrigin(process.env.BASE_URL);
  const response = await fetch(`${base}/__ui/repairs-control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario: "home-cta", mode: "populated" }),
  });
  const state = await response.json();
  if (response.status !== 200 || state.active !== true || state.scenario !== "home-cta" || state.mode !== "populated" || state.denial || Object.keys(state.seed || {}).length) {
    throw new Error("Owned synthetic CTA fixture did not acknowledge clean state.");
  }
  const artifact = path.resolve(__dirname, "../../test-results", `cta-${process.env.CTA_PHASE || "baseline"}-fixture.json`);
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, JSON.stringify({ base, status: response.status, scenario: state.scenario, mode: state.mode, denial: state.denial, seed: state.seed, syntheticLocalOnly: true }, null, 2) + "\n");
};
