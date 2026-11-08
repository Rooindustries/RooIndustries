const normalizeTools = (tools) => tools.map((tool) => {
  const url = tool?.iconUrl;
  const separator = url?.includes("?") ? "&" : "?";
  return { ...tool, iconUrl: url ? `${url}${separator}auto=format&fit=max&w=64&h=64` : "" };
});

module.exports = { normalizeTools };
