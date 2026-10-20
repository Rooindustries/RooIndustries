const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
const QUERY = /((?:https?:\/\/|\/)[^\s?#"'<>]*)\?[^\s#"'<>]+/g;
const SENSITIVE_KEY =
  /pass|token|secret|cookie|session|auth|signature|email|phone|address|card|cvv|cvc|iban|upi|vpa|billing|payment_?method|customer/i;
const NAME_KEY = /^(?:full|first|last|display|customer|user)_?name$|^handle$|discord/i;

export const NO_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};

function passesLuhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function scrubText(text) {
  return text
    .replace(QUERY, "$1?[query]")
    .replace(EMAIL, "[email]")
    .replace(CARD, (match) => (passesLuhn(match.replace(/[ -]/g, "")) ? "[card]" : match));
}

function scrubValue(value, depth = 0) {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[Filtered]";
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = SENSITIVE_KEY.test(key) || NAME_KEY.test(key) ? "[Filtered]" : scrubValue(item, depth + 1);
  }
  return copy;
}

function withoutQuery(url) {
  if (typeof url !== "string") return undefined;
  const end = url.search(/[?#]/);
  return scrubText(end === -1 ? url : url.slice(0, end));
}

export function scrubBreadcrumb(breadcrumb) {
  if (breadcrumb.category === "console") return null;
  if (breadcrumb.message) breadcrumb.message = scrubText(breadcrumb.message);
  if (breadcrumb.data) {
    const data = scrubValue(breadcrumb.data);
    if (data && typeof data === "object") {
      for (const key of ["url", "from", "to"]) if (key in data) data[key] = withoutQuery(data[key]);
    }
    breadcrumb.data = data;
  }
  return breadcrumb;
}

export function scrubEvent(event) {
  delete event.user;
  if (event.request) {
    const agent = event.request.headers?.["User-Agent"];
    event.request = {
      method: event.request.method,
      url: withoutQuery(event.request.url),
      ...(agent ? { headers: { "User-Agent": agent } } : {}),
    };
  }
  if (event.message) event.message = scrubText(event.message);
  if (event.logentry) event.logentry = scrubValue(event.logentry);
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = scrubText(value.value);
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter(Boolean);
  if (event.extra) event.extra = scrubValue(event.extra);
  if (event.contexts) event.contexts = scrubValue(event.contexts);
  if (event.tags) event.tags = scrubValue(event.tags);
  return event;
}

export function monitoringEnvironment() {
  return process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV || process.env.NODE_ENV;
}

export function envelopeHeaderScrubber(dsn, environment) {
  const publicKey = new URL(dsn).username;
  return (envelope) => {
    const header = Array.isArray(envelope) ? envelope[0] : undefined;
    if (!header?.trace) return;
    const traceId = header.trace.trace_id;
    if (typeof traceId === "string" && /^[0-9a-f]{32}$/.test(traceId)) {
      header.trace = { trace_id: traceId, public_key: publicKey, ...(environment ? { environment } : {}) };
    } else {
      delete header.trace;
    }
  };
}
