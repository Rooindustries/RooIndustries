const appendQueryParam = (params, key, value) => {
  if (value === undefined || value === null) return;
  params.append(String(key), String(value));
};

export const buildQueryString = (searchParams) => {
  if (!searchParams || typeof searchParams !== "object") return "";
  const params = new URLSearchParams();

  if (typeof searchParams.entries === "function") {
    for (const [key, value] of searchParams.entries()) {
      appendQueryParam(params, key, value);
    }
    const query = params.toString();
    return query ? `?${query}` : "";
  }

  Object.entries(searchParams).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        appendQueryParam(params, key, item);
      });
      return;
    }

    appendQueryParam(params, key, value);
  });

  const query = params.toString();
  return query ? `?${query}` : "";
};
