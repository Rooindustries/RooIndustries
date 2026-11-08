import fs from "node:fs";

export const isProductionMonitor = () => {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "deployment_status" ||
      process.env.GITHUB_WORKFLOW_REF?.toLowerCase() !== "rooindustries/rooindustries/.github/workflows/production-smoke.yml@refs/heads/main") return false;
  try {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const deployment = new URL(event.deployment_status?.environment_url);
    return event.repository?.full_name?.toLowerCase() === "rooindustries/rooindustries" &&
      event.deployment?.environment === "Production" && event.deployment_status?.state === "success" &&
      deployment.protocol === "https:" && !deployment.username && !deployment.password &&
      deployment.pathname === "/" && !deployment.search && !deployment.hash &&
      event.deployment_status?.environment_url === process.env.DEPLOYMENT_URL;
  } catch {
    return false;
  }
};
