export const smokeRequest = async (url, options = {}) => {
  if ((options.method || "GET").toUpperCase() !== "GET" || options.body != null) {
    throw new Error("Production smoke requests must be GET-only.");
  }
  const response = await fetch(url, { ...options, method: "GET", redirect: "manual" });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${new URL(url).pathname} answered ${response.status}`);
  }
  return response;
};
