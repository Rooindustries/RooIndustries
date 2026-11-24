(function () {
  var KEY = "roo_ref", MAX_AGE_S = 2592000, MAX_AGE_MS = 2592000000, SKEW_MS = 3600000, mem = null;
  var REF_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
  var ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
  function norm(v) {
    var s = typeof v === "string" ? v.trim().toLowerCase() : "";
    return s && REF_RE.test(s) && s.replace(/[^0-9]/g, "").length < 7 ? s : "";
  }
  function parseTs(v) {
    var m = typeof v === "string" ? ISO_RE.exec(v) : null;
    if (!m) return NaN;
    var y = +m[1], mo = +m[2], da = +m[3], h = +m[4], mi = +m[5], s = +m[6];
    var ms = m[7] ? +(m[7] + "000").slice(0, 3) : 0;
    if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59 || s > 59) return NaN;
    var t = Date.UTC(y, mo - 1, da, h, mi, s, ms), d = new Date(t);
    var ok = d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1 && d.getUTCDate() === da &&
      d.getUTCHours() === h && d.getUTCMinutes() === mi && d.getUTCSeconds() === s && d.getUTCMilliseconds() === ms;
    return ok ? t : NaN;
  }
  function clean(v, now) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    var src = norm(v.source), ts = src ? parseTs(v.capturedAt) : NaN;
    if (!isFinite(ts) || ts > now + SKEW_MS || now - ts >= MAX_AGE_MS) return null;
    return { source: src, capturedAt: new Date(ts).toISOString() };
  }
  function parseRaw(raw, now) {
    try {
      return raw ? clean(JSON.parse(decodeURIComponent(raw)), now) : null;
    } catch (_) {
      return null;
    }
  }
  function readCookie() {
    try {
      var pairs = document.cookie ? document.cookie.split(/;\s*/) : [];
      for (var i = 0; i < pairs.length; i++) {
        if (pairs[i].indexOf(KEY + "=") === 0) return pairs[i].slice(KEY.length + 1);
      }
    } catch (_) {}
    return "";
  }
  function setCookie(entry, now) {
    try {
      var val = entry ? encodeURIComponent(JSON.stringify(entry)) : "";
      var left = entry ? Math.floor((parseTs(entry.capturedAt) + MAX_AGE_MS - now) / 1000) : 0;
      var age = entry ? Math.max(1, Math.min(MAX_AGE_S, left)) : 0;
      var sec = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = KEY + "=" + val + "; Path=/; Max-Age=" + age + "; SameSite=Lax" + sec;
    } catch (_) {}
  }
  function store(op, val) {
    try {
      var ls = window.localStorage;
      if (!ls) return null;
      if (op === "set") return ls.setItem(KEY, val);
      if (op === "del") return ls.getItem(KEY) !== null && ls.removeItem(KEY);
      return ls.getItem(KEY);
    } catch (_) {}
    return null;
  }
  function readRef(reconcile) {
    var now = Date.now(), ck = parseRaw(readCookie(), now), ls = parseRaw(store("get"), now);
    var list = [ck, ls, clean(mem, now)], best = null, bestTs = Infinity;
    for (var i = 0; i < list.length; i++) {
      var item = list[i], ts = item ? parseTs(item.capturedAt) : Infinity;
      if (item && ts < bestTs) {
        best = item;
        bestTs = ts;
      }
    }
    mem = best;
    if (!best) {
      if (reconcile && readCookie()) setCookie(null, now);
      if (reconcile) store("del");
      return null;
    }
    if (reconcile) {
      if (!ck || ck.source !== best.source || ck.capturedAt !== best.capturedAt) setCookie(best, now);
      if (!ls || ls.source !== best.source || ls.capturedAt !== best.capturedAt) {
        store("set", encodeURIComponent(JSON.stringify(best)));
      }
    }
    return best;
  }
  function captureRef(search, pathname) {
    var path = typeof pathname === "string" && pathname ? pathname : (window.location.pathname || "/");
    if (path === "/admin" || path.indexOf("/admin/") === 0) return readRef(false);
    var existing = readRef(true);
    if (existing) return existing;
    var q = typeof search === "string" ? search : (window.location.search || ""), src = "";
    try {
      src = norm(new URLSearchParams(q).get("ref") || "");
    } catch (_) {
      return null;
    }
    if (!src) return null;
    var now = Date.now(), entry = { source: src, capturedAt: new Date(now).toISOString() };
    mem = entry;
    setCookie(entry, now);
    store("set", encodeURIComponent(JSON.stringify(entry)));
    return entry;
  }
  window.__rooReadRef = readRef.bind(null, true);
  window.__rooCaptureRef = captureRef;
  window.__rooChooseRef = function (stored) {
    var now = Date.now(), live = readRef(true), cand = clean(stored, now);
    if (live && cand) return parseTs(cand.capturedAt) < parseTs(live.capturedAt) ? cand : live;
    return live || cand;
  };
  captureRef(window.location.search, window.location.pathname);
})();