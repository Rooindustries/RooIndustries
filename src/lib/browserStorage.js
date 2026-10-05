export const readBrowserStorage = (name, key) => {
  try { return typeof window === 'undefined' ? null : window[name].getItem(key); } catch { return null; }
};

export const writeBrowserStorage = (name, key, value) => {
  try {
    if (typeof window === 'undefined') return false;
    const storage = window[name];
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch { return false; }
};

export const removeBrowserStorage = (name, key) => {
  try {
    if (typeof window === 'undefined') return false;
    window[name].removeItem(key);
    return true;
  } catch { return false; }
};
