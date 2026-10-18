import type { AccountId } from "@cerium/protocol";
import { verifyToken } from "@clerk/backend";

import type { Env } from "./env.ts";
import { bearer } from "./http.ts";

/**
 * The Clerk user a request's session token belongs to, verified against the instance's JWT key
 * without a network call. The token must come from the relay's own sign-in page.
 */
export const clerkUser = async (request: Request, env: Env): Promise<AccountId | undefined> => {
  const token = bearer(request);
  if (token === undefined) return undefined;
  try {
    const payload = await verifyToken(token, {
      // .dev.vars and secrets keep the PEM on one line, with `\n` for its line breaks.
      jwtKey: env.CLERK_JWT_KEY.replaceAll("\\n", "\n"),
      authorizedParties: [env.PUBLIC_ORIGIN],
    });
    return payload.sub as AccountId;
  } catch {
    return undefined;
  }
};
