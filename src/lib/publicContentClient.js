const buildPublicContentUrl = (resource, params = {}) => {
  const url = new URL(
    `/api/content/${encodeURIComponent(resource)}`,
    window.location.origin
  );
  Object.entries(params).forEach(([key, value]) => {
    const values = Array.isArray(value) ? value : [value];
    values
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .forEach((item) => url.searchParams.append(key, item));
  });
  return `${url.pathname}${url.search}`;
};

export const getPublicContent = async (resource, params = {}) => {
  const response = await fetch(buildPublicContentUrl(resource, params), {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.error || "Public content could not be loaded.");
  }
  return body.data ?? null;
};
