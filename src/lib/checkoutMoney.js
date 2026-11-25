const ZERO_DEC = new Set("BIF,CLP,DJF,GNF,ISK,JPY,KMF,KRW,PYG,RWF,UGX,UYI,VND,VUV,XAF,XOF,XPF".split(","));
const THREE_DEC = new Set("BHD,IQD,JOD,KWD,LYD,OMR,TND".split(","));
export const parseMoneyValue = (v) => { const n = typeof v === "string" ? v.trim().replace(/,/g, "").replace(/[$€£₹]/g, "").replace(/\s+[A-Z]{3}$/i, "").trim() : v; const p = Number(n); return (typeof n === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(n)) || !Number.isFinite(p) ? null : p; };
export const normalizeCurrencyCode = (c = "USD") => (/^[A-Z]{3}$/.test(String(c || "").trim().toUpperCase()) ? String(c).trim().toUpperCase() : "USD");
export const currencyDecimals = (c = "USD") => { const k = normalizeCurrencyCode(c); return ZERO_DEC.has(k) ? 0 : THREE_DEC.has(k) ? 3 : 2; };
export const toMoney = (v, c = "USD") => { const p = parseMoneyValue(v); return p === null ? 0 : +p.toFixed(currencyDecimals(c)); };
export const toSubunitsClient = (v, c = "USD") => { const p = parseMoneyValue(v); return p === null ? 0 : Math.round(p * 10 ** currencyDecimals(c)); };
export const formatCheckoutAmount = (amount, c = "USD", { includeCurrency = true } = {}) => {
  const code = normalizeCurrencyCode(c), f = toMoney(amount, code).toFixed(currencyDecimals(code));
  return code === "USD" ? (includeCurrency ? `$${f} USD` : `$${f}`) : `${f} ${code}`;
};
