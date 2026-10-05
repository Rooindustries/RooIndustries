import { localOrigin, refuseEnvFiles, installNetworkGuard } from "./lib/test-target-safety.mjs";

refuseEnvFiles();
const baseUrl = localOrigin(process.env.BASE_URL);
installNetworkGuard([baseUrl]);
const request = async (pathname, { method = "GET", body } = {}) => {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
try {
  const providers = await request("/api/payment/providers");
  const paypal = await request("/api/payment/webhook/paypal", { method: "POST", body: {} });
  const razorpay = await request("/api/payment/webhook/razorpay", { method: "POST", body: {} });
  const environment = providers.body?.environment;
  const passed = providers.status === 200 && providers.body?.ok === true &&
    ["development", "preview"].includes(environment?.runtime) && environment.livePaymentsEnabled === false &&
    paypal.status === 401 && razorpay.status === 401;
  console.log(JSON.stringify({ baseUrl, passed, providers: { status: providers.status, environment }, unsignedWebhooks: { paypal: paypal.status, razorpay: razorpay.status } }, null, 2));
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error(`[check-payment-stack] ${error.message}`);
  process.exitCode = 1;
}
