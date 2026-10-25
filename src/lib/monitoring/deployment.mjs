export function isProductionDeployment() {
  return process.env.NODE_ENV === "production" &&
    process.env.VERCEL === "1" &&
    process.env.VERCEL_ENV === "production";
}
