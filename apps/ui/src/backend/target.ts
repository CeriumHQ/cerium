/**
 * Whether this is the web client (docs/architecture.md §14.10), which the relay serves and which
 * reaches machines through its own relay connection; otherwise it's a desktop's UI, which reaches
 * them through its own backend. Fixed at build time (`vp build --mode web`).
 */
export const WEB = import.meta.env.MODE === "web";
