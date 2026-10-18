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

/** What this tab remembers until it closes: it survives a reload, and other tabs don't see it. */
export const storedForTab = (key: string): string | undefined => {
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};

export const rememberForTab = (key: string, value: string): void => {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Not remembered this time.
  }
};
