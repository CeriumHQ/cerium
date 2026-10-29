// What the relay's pages share: reading and writing the relay's API, and signing in with Clerk in
// Cerium's colours.

const CLERK_JS_VERSION = "6.37.0";
const CLERK_UI_VERSION = "1.38.1";

export const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

/** A JSON request to the relay; `body` is its answer, or its refusal's `{ message }`. */
export const request = async (path, init) => {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
};

const loadScript = (src, attributes = {}) =>
  new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.crossOrigin = "anonymous";
    script.async = true;
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    script.addEventListener("load", resolve);
    script.addEventListener("error", () => reject(new Error(`Couldn't load ${src}`)));
    document.head.append(script);
  });

/** Clerk's Frontend API host, which the publishable key encodes (`pk_test_<base64 of "host$">`). */
const frontendApi = (publishableKey) => atob(publishableKey.split("_")[2] ?? "").replace(/\$$/, "");

/**
 * Clerk's components in Cerium's tokens, flattened into this page's panel. The accent goes by the
 * aliases in link.css, since Clerk's buttons define an `--accent` of their own.
 */
const appearance = {
  variables: {
    colorPrimary: "var(--cerium-accent)",
    colorPrimaryForeground: "var(--cerium-accent-fg)",
    colorBackground: "var(--surface-raised)",
    colorForeground: "var(--fg-primary)",
    colorMutedForeground: "var(--fg-tertiary)",
    colorInput: "var(--surface-sunken)",
    colorInputForeground: "var(--fg-primary)",
    colorNeutral: "var(--fg-primary)",
    colorBorder: "var(--line-strong)",
    colorDanger: "var(--status-error)",
    fontFamily: "var(--font-sans)",
    borderRadius: "12px",
  },
  elements: {
    rootBox: { width: "100%" },
    cardBox: {
      width: "100%",
      boxShadow: "none",
      border: "none",
      borderRadius: "0",
      background: "transparent",
    },
    // Clerk offsets the card a pixel each way for a border it no longer has here.
    card: {
      padding: "0",
      margin: "0",
      width: "100%",
      boxShadow: "none",
      border: "none",
      background: "transparent",
    },
    header: { display: "none" },
    footer: { background: "transparent" },
    // The website's pill.
    formButtonPrimary: {
      height: "44px",
      borderRadius: "999px",
      backgroundColor: "var(--cerium-accent)",
      backgroundImage: "none",
      color: "var(--cerium-accent-fg)",
      boxShadow: "none",
      border: "none",
      "&:hover, &:focus": { backgroundColor: "var(--cerium-accent-strong)" },
    },
    socialButtonsIconButton: {
      backgroundColor: "var(--surface-sunken)",
      border: "1px solid var(--line-subtle)",
      boxShadow: "none",
      "&:hover": { backgroundColor: "var(--surface-hover)", borderColor: "var(--line-strong)" },
    },
    socialButtonsBlockButton: {
      backgroundColor: "var(--surface-sunken)",
      border: "1px solid var(--line-subtle)",
      boxShadow: "none",
      "&:hover": { backgroundColor: "var(--surface-hover)", borderColor: "var(--line-strong)" },
    },
    formFieldInput: { border: "1px solid var(--line-subtle)", boxShadow: "none" },
    dividerLine: { backgroundColor: "var(--line-subtle)" },
  },
};

/** Clerk, loaded from the instance's Frontend API and dressed as Cerium. */
export const loadClerk = async (publishableKey) => {
  const host = frontendApi(publishableKey);
  await loadScript(`https://${host}/npm/@clerk/ui@${CLERK_UI_VERSION}/dist/ui.browser.js`);
  await loadScript(`https://${host}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`, {
    "data-clerk-publishable-key": publishableKey,
  });
  const clerk = window.Clerk;
  await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor }, appearance });
  return clerk;
};
