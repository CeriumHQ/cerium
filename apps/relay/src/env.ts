import type { Account } from "./account.ts";
import type { Link } from "./link.ts";

/** The relay's bindings (wrangler.jsonc) and settings (.dev.vars locally, Wrangler secrets deployed). */
export interface Env {
  readonly ACCOUNTS: DurableObjectNamespace<Account>;
  readonly LINKS: DurableObjectNamespace<Link>;
  readonly ASSETS: Fetcher;
  /**
   * Where the relay is reached, which links point at and session tokens must come from. Set rather
   * than read from requests, since `wrangler dev` rewrites their host to the production route.
   */
  readonly PUBLIC_ORIGIN: string;
  /**
   * Development only: other origins that may sign devices in, comma-separated, such as the web UI's
   * dev server (`http://localhost:5174`), which proxies the relay.
   */
  readonly DEV_ORIGINS?: string;
  /** The Clerk instance's publishable key; the sign-in page loads Clerk with it. */
  readonly CLERK_PUBLISHABLE_KEY: string;
  /** The Clerk instance's JWT public key (PEM), for verifying session tokens without a network call. */
  readonly CLERK_JWT_KEY: string;
  /**
   * The relay's VAPID key pair for push notifications (§14.11), as `scripts/vapid.ts` makes it.
   * Without both, the relay sends none and the web client doesn't offer them.
   */
  readonly VAPID_PUBLIC_KEY?: string;
  readonly VAPID_PRIVATE_KEY?: string;
  /** How push services reach whoever runs the relay: an `https:` or `mailto:` URL. */
  readonly VAPID_SUBJECT: string;
}

/** The relay's VAPID keys, when it has them. */
export const vapidKeys = (env: Env) =>
  env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
    ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT }
    : undefined;
