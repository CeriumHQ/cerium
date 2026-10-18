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
  /** The Clerk instance's publishable key; the sign-in page loads Clerk with it. */
  readonly CLERK_PUBLISHABLE_KEY: string;
  /** The Clerk instance's JWT public key (PEM), for verifying session tokens without a network call. */
  readonly CLERK_JWT_KEY: string;
}
