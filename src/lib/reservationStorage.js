import { removeBrowserStorage, writeBrowserStorage } from "./browserStorage";

const saved = new Map();
const unpersisted = new Set();

export const readReservationStorage = (key) => {
  if (typeof window === "undefined") return null;
  if (unpersisted.has(key)) return saved.get(key) || null;
  try {
    const value = window.sessionStorage.getItem(key);
    saved.set(key, value);
    return value;
  } catch {
    return saved.get(key) || null;
  }
};

export const writeReservationStorage = (key, value) => {
  saved.set(key, value);
  const persisted = writeBrowserStorage("sessionStorage", key, value);
  if (persisted) unpersisted.delete(key);
  else unpersisted.add(key);
  return persisted;
};

export const removeReservationStorage = (key) => {
  saved.delete(key);
  const removed = removeBrowserStorage("sessionStorage", key);
  if (removed) unpersisted.delete(key);
  else unpersisted.add(key);
  return removed;
};
