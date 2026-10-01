// Small per-browser settings (sidebar collapsed, dark mode).
// Private windows or blocked storage just fall back to the default.

export function loadPref(key, fallback) {
  try {
    const raw = window.localStorage.getItem(`mmer3.${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function savePref(key, value) {
  try {
    window.localStorage.setItem(`mmer3.${key}`, JSON.stringify(value));
  } catch {
    // not saved, fine
  }
}
