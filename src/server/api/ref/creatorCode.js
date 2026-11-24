import { isKnownAdRefTag, normalizeRef } from "../../../lib/refShape.js";

export const CREATOR_CODE = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;
export const isSafeCreatorCode = (value) => {
  const code = String(value ?? "").trim().toLowerCase();
  return Boolean(code && CREATOR_CODE.test(code) && normalizeRef(code) === code && !isKnownAdRefTag(code));
};
export const creatorCode = (value) => {
  const code = String(value ?? "").trim().toLowerCase();
  return isSafeCreatorCode(code) ? code : "";
};
