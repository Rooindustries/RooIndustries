const RULE = /^\(\{parent\}\)\s*=>\s*\(?parent\?\.([A-Za-z0-9_]+)(?:\s*\|\|\s*'([^']*)')?\)?\s*(===|!==)\s*'([^']*)'$/;

export const isFieldHidden = (field, parent) => {
  if (field?.hidden === true) return true;
  if (!field?.hiddenRule) return false;
  const match = String(field.hiddenRule).trim().match(RULE);
  if (!match) return false;
  const [, name, fallback, operator, expected] = match;
  const actual = parent?.[name] ?? (fallback !== undefined ? fallback : undefined);
  const resolved = actual === undefined || actual === null || actual === "" ? fallback ?? actual : actual;
  return operator === "===" ? resolved === expected : resolved !== expected;
};

export const optionValue = (option) =>
  option && typeof option === "object" ? option.value : option;

export const optionTitle = (option) =>
  option && typeof option === "object" ? option.title ?? String(option.value) : String(option);

export const slugify = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export const isPortableTextField = (field) =>
  field?.type === "array" &&
  Array.isArray(field.of) &&
  field.of.length > 0 &&
  field.of.every((item) => item?.type === "block");

export const defaultsFor = (fields = []) =>
  Object.fromEntries(
    fields
      .filter((field) => field.initialValue !== undefined)
      .map((field) => [field.name, JSON.parse(JSON.stringify(field.initialValue))])
  );

export const toLocalDateTimeInput = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const fromLocalDateTimeInput = (value) => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};
