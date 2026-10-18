import { WEB } from "./target.ts";

/**
 * Opens Cerium's sign-in page at `url`: in the user's browser for a desktop. The web client opens it
 * in its own tab, on its own origin, since a Home Screen app opens no windows and keeps its storage
 * apart from Safari's (docs/architecture.md §14.10); the page sends it back once confirmed.
 */
export const openSignIn = (url: string) => {
  if (WEB) location.assign(signInHref(url));
  else window.open(url, "_blank", "noopener,noreferrer");
};

/** Where a link to the sign-in page points: the relay's page, or the web client's own origin. */
export const signInHref = (url: string) => (WEB ? `/link${new URL(url).hash}` : url);
