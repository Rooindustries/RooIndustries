const CARD = /\b\d(?:[\s._-]?\d){12,18}\b/g;
const QUERY = /\?[^\s#"'<>]+/g;
const SENSITIVE_KEY =
  /pass|token|secret|cookie|session|auth|signature|email|phone|address|card|cvv|cvc|iban|upi|vpa|billing|payment|customer/i;
const NAME_KEY = /^(?:full|first|last|display|customer|user)_?name$|^handle$|discord/i;
const VERSIONED_RELEASE = /^(?:@[\w.-]+\/)?[\w.-]+@v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

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
    .replace(/\S+/g, (token) => {
      let dot = token.length;
      let separator = token.length;
      for (let i = token.length - 1; i > 0; i--) {
        if (token[i] === "/" || token[i] === "\\") separator = i;
        else if (token[i] === ".") dot = i;
        else if (token[i] === "@" && dot > i + 1 && dot < separator && dot < token.length - 1) return "[email]";
      }
      return token;
    })
    .replace(CARD, "[card]")
    .replace(QUERY, "?[query]")
    .replace(/\/\/[^\s/?#"'<>]*@/g, "//");
}

function scrubValue(value, depth = 0, path = []) {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[Filtered]";
  if (Array.isArray(value)) return value.map((item, index) => scrubValue(item, depth + 1, [...path, index]));
  const trace = path.length === 2 && (path[0] === "contexts" && path[1] === "trace" || path[0] === "spans" && typeof path[1] === "number");
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["headers", "user_agent.original"].includes(key.toLowerCase())).map(([key, item]) => {
    const identifier = trace && typeof item === "string" && (
      (key === "span_id" || key === "parent_span_id") && /^[0-9a-f]{16}$/i.test(item) ||
      key === "trace_id" && /^[0-9a-f]{32}$/i.test(item)
    );
    const release = path.length === 0 && key === "release" && typeof item === "string" && VERSIONED_RELEASE.test(item) && item.replace(CARD, "[card]") === item;
    return [scrubText(key), identifier || release ? item : SENSITIVE_KEY.test(key) || NAME_KEY.test(key) ? "[Filtered]" : scrubValue(item, depth + 1, [...path, key])];
  }));
}

function withoutQuery(url) {
  if (typeof url !== "string") return undefined;
  const end = url.search(/[?#]/);
  return scrubText(end === -1 ? url : url.slice(0, end));
}

function networkData(data = {}, description) {
  const target = data["url.full"] ?? data["http.url"] ?? data.url ?? (typeof description === "string" ? description.replace(/^[A-Z]+ /, "") : undefined);
  let url;
  if (typeof target === "string") {
    try {
      const parsed = new URL(target);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") url = scrubText(parsed.origin);
    } catch {}
  }
  const candidate = data["http.request.method"] ?? data["http.method"] ?? data.method ?? (typeof description === "string" ? description.split(" ", 1)[0] : undefined);
  const method = typeof candidate === "string" && /^(CONNECT|DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT|TRACE)$/.test(candidate.toUpperCase()) ? candidate.toUpperCase() : undefined;
  const status = data["http.response.status_code"] ?? data["http.status_code"] ?? data.status_code;
  const status_code = typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 599 ? status : undefined;
  return { url, method, status_code };
}

function scrubNetworkSpan(span) {
  span.data = networkData(span.data, span.description);
  span.description = [span.data.method, span.data.url].filter(Boolean).join(" ") || "HTTP request";
}

export function scrubBreadcrumb(breadcrumb) {
  if (breadcrumb.category === "console") return null;
  if (["http", "fetch", "xhr"].includes(breadcrumb.category)) {
    delete breadcrumb.message;
    breadcrumb.data = networkData(breadcrumb.data);
    return breadcrumb;
  }
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
    event.request = {
      method: event.request.method,
      url: withoutQuery(event.request.url),
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
  for (const span of event.spans ?? []) if (span.op === "http.client") scrubNetworkSpan(span);
  const trace = event.contexts?.trace;
  if (trace?.op === "http.client") {
    const span = { data: trace.data, description: event.transaction };
    scrubNetworkSpan(span);
    trace.data = span.data;
    event.transaction = span.description;
    if (event.request) event.request.url = networkData({ url: event.request.url }).url;
  }
  return scrubValue(event);
}

export function monitoringEnvironment(value = process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV || process.env.NODE_ENV || "production") {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) && value !== "None" && scrubText(value) === value ? value : "unknown";
}

export function monitoringDsn(value) {
  try {
    const url = new URL(value);
    const loopbackHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !loopbackHttp) || !/^\w+$/.test(url.username) || !/\/\d+$/.test(url.pathname) || url.search || url.hash) return undefined;
    url.password = "";
    return url.href;
  } catch {
    return undefined;
  }
}

export function envelopeHeaderScrubber(publicKey, environment) {
  return (envelope) => {
    const header = Array.isArray(envelope) ? envelope[0] : undefined;
    if (!header?.trace) return;
    const traceId = header.trace.trace_id;
    if (publicKey && typeof traceId === "string" && /^[0-9a-f]{32}$/.test(traceId)) {
      header.trace = { trace_id: traceId, public_key: publicKey, ...(environment ? { environment: monitoringEnvironment(environment) } : {}) };
    } else {
      delete header.trace;
    }
  };
}
