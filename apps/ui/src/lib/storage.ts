// Remembered window preferences are a convenience only: storage failing must never break the app.

export const stored = (key: string): string | undefined => {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};

export const remember = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered this time.
  }
};

/** Per-tab state survives a reload, and the desktop's main tab also keeps it through hibernation. */
export const storedForTab = (key: string): string | undefined => {
  try {
    return sessionStorage.getItem(key) ?? window.cerium?.tabState?.(key);
  } catch {
    return undefined;
  }
};

export const rememberForTab = (key: string, value: string): void => {
  try {
    sessionStorage.setItem(key, value);
    window.cerium?.rememberTabState?.(key, value);
  } catch {
    // Not remembered this time.
  }
};
