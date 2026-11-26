import {
  isRecord as isPlainRecord,
  readStoredAttribution,
  storeAttributionForConsent,
  writeStoredAttribution,
} from "./attributionConsentLock";

export const isRecord = (value: unknown): value is Record<string, unknown> => isPlainRecord(value);

export { readStoredAttribution, storeAttributionForConsent, writeStoredAttribution };
