/**
 * Whether this is the web client, which the relay serves and which
 * reaches machines through its own relay connection; otherwise it's a desktop's UI, which reaches
 * them through its own backend. Fixed at build time (`vp build --mode web`).
 */
export const WEB = import.meta.env.MODE === "web";

/** The version this build is: the release's, or `dev`. */
export const BUILD_VERSION = import.meta.env.DEV ? "dev" : __CERIUM_VERSION__;
