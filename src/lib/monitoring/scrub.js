const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
const QUERY = /\?[^\s#"'<>]+/g;
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
  frameContextLines: 0,
};

export function scrubText(text) {
  return text
    .replace(QUERY, "?[query]")
    .replace(/\S+/g, (token) => {
      const at = token.indexOf("@");
      const dot = at > 0 ? token.indexOf(".", at + 2) : -1;
      return dot !== -1 && dot < token.length - 1 ? "[email]" : token;
    })
    .replace(CARD, "[card]");
}

function scrubValue(value, depth = 0, path = []) {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[Filtered]";
  if (Array.isArray(value)) return value.map((item, index) => scrubValue(item, depth + 1, [...path, index]));
  const trace = path.length === 2 && (path[0] === "contexts" && path[1] === "trace" || path[0] === "spans" && typeof path[1] === "number");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const identifier = trace && typeof item === "string" && (
      (key === "span_id" || key === "parent_span_id") && /^[0-9a-f]{16}$/i.test(item) ||
      key === "trace_id" && /^[0-9a-f]{32}$/i.test(item)
    );
    return [scrubText(key), identifier ? item : SENSITIVE_KEY.test(key) || NAME_KEY.test(key) ? "[Filtered]" : scrubValue(item, depth + 1, [...path, key])];
  }));
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
  for (const value of event.exception?.values ?? []) {
    for (const frame of value.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = withoutQuery(frame.filename);
      if (frame.abs_path) frame.abs_path = withoutQuery(frame.abs_path);
      if (frame.module) frame.module = withoutQuery(frame.module);
    }
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter(Boolean);
  return scrubValue(event);
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
