export const CREATOR_CODE = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;

export const creatorCode = (value) => {
  const code = String(value ?? "").trim().toLowerCase();
  return CREATOR_CODE.test(code) ? code : "";
};
