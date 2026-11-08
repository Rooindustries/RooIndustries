import { isProductionMonitor } from "./production-monitor.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const isCiTarget = url =>
  url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password;

export class SmokeRequestRefusal extends Error {}
export class SmokeResponseError extends Error {}
export const isSmokeRedirect = response => [301, 302, 303, 307, 308].includes(response.status) &&
  response.headers.has("location");

export const smokeErrorDetail = error => {
  const detail = error?.message ?? String(error);
  return error?.cause ? `${detail}: ${smokeErrorDetail(error.cause)}` : detail;
};

const transportError = (error, url) => {
  if (!["AbortError", "TimeoutError"].includes(error?.name) &&
      !(error instanceof TypeError && error.cause?.code)) return error;
  const detail = error.name === "TimeoutError" ? "timed out" : smokeErrorDetail(error);
  return new SmokeResponseError(`${new URL(url).pathname} ${detail}`, { cause: error });
};

export const smokeRequest = async (url, options = {}) => {
  if ((options.method || "GET").toUpperCase() !== "GET" || options.body != null) {
    throw new SmokeRequestRefusal("Production smoke requests must be GET-only.");
  }
  let target = new URL(url);
  const origin = target.origin;
  for (let redirects = 0; ; redirects += 1) {
    if (process.env.GITHUB_ACTIONS === "true" && !isCiTarget(target) && !isProductionMonitor()) {
      throw new SmokeRequestRefusal(`${target.pathname} is blocked by the smoke request policy`);
    }
    const provider = /(?:^|\.)(?:paypal|razorpay|dodopayments)\.com$/.test(target.hostname);
    if (provider && /\/(?:orders?|payments?|checkouts?|subscriptions?)(?:\/|$)/i.test(
      decodeURIComponent(target.pathname)
    )) {
      throw new SmokeRequestRefusal("Production smoke cannot request provider order or payment APIs.");
    }
    const headers = new Headers(options.headers);
    if (target.origin !== origin) headers.delete("x-vercel-protection-bypass");
    let response;
    try {
      response = await fetch(target, { ...options, headers, method: "GET", redirect: "manual" });
    } catch (error) {
      throw transportError(error, target);
    }
    if (isSmokeRedirect(response)) {
      if (options.redirect === "manual") return response;
      await response.body?.cancel();
      if (redirects >= 20) throw new SmokeResponseError(`${target.pathname} exceeded the redirect limit`);
      try {
        target = new URL(response.headers.get("location"), target);
      } catch (error) {
        throw new SmokeResponseError(`${target.pathname} has an invalid redirect`, { cause: error });
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SmokeResponseError(`${target.pathname} answered ${response.status}`);
    }
    return response;
  }
};

export const smokeResponseBody = async response => {
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw transportError(error, response.url);
  }
};
