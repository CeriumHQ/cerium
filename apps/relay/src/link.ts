import {
  LINK_LIFETIME_MS,
  type AccountId,
  type ClaimLinkResponse,
  type ConfirmLinkRequest,
  type CreateLinkRequest,
  type LinkId,
  type LinkView,
} from "@cerium/protocol";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env.ts";
import { approve, claim, handoffUrl, startLink, viewOf, type Pending, type Refusal } from "./linking.ts";

// One pending sign-in, named by its unguessable id. The user confirms it in their browser, whose page
// hands the code that finishes it to the machine beside it; the machine claims it with that code and
// its device secret (linking.ts). It stays claimable until it expires, so a claim whose answer was
// lost can be made again.

export type CreateOutcome = { readonly ok: true; readonly expiresAt: number } | Refusal;

export type ConfirmOutcome = { readonly ok: true; readonly next: string } | Refusal;

export type ClaimOutcome = ClaimLinkResponse | "expired" | "forbidden";

export class Link extends DurableObject<Env> {
  /** One confirmation or claim at a time: two clicks, or two claims, mustn't race. */
  private queue: Promise<unknown> = Promise.resolve();

  async create(request: CreateLinkRequest): Promise<CreateOutcome> {
    const link = startLink(request, Date.now() + LINK_LIFETIME_MS);
    if ("ok" in link) return link;
    await this.ctx.storage.put<Pending>("link", link);
    await this.ctx.storage.setAlarm(link.expiresAt);
    return { ok: true, expiresAt: link.expiresAt };
  }

  async view(): Promise<LinkView | undefined> {
    const link = await this.read();
    return link === undefined ? undefined : viewOf(link);
  }

  /** The user, signed in with Clerk, lets the machine into their account. */
  async confirm(
    id: LinkId,
    accountId: AccountId,
    profile: ConfirmLinkRequest["profile"],
  ): Promise<ConfirmOutcome> {
    return this.serially(async () => {
      const link = await this.read();
      if (link === undefined)
        return { ok: false, status: 410, message: "This sign-in link has expired. Start again from Cerium." };
      const approved = await approve(link, accountId, profile);
      if (!approved.ok) return approved;
      await this.ctx.storage.put<Pending>("link", approved.link);
      return { ok: true, next: handoffUrl(id, approved.link, approved.code) };
    });
  }

  /** The machine that started the sign-in, with its secret and, once the page handed it over, the code. */
  async claim(secret: string, code: string | undefined): Promise<ClaimOutcome> {
    return this.serially(async () => {
      const link = await this.read();
      if (link === undefined) return "expired";
      const outcome = await claim(link, secret, code);
      switch (outcome._tag) {
        case "forbidden":
          return "forbidden";
        case "burn":
          await this.ctx.storage.deleteAll();
          return "expired";
        case "wait":
          return { _tag: "Pending" };
        case "linked":
          return { _tag: "Linked", account: outcome.account, deviceId: outcome.deviceId };
        case "join": {
          const { id: accountId, ...profile } = outcome.account;
          const account = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(accountId));
          const deviceId = await account.link(
            accountId,
            link.device,
            link.secretHash,
            link.installation,
            profile,
          );
          await this.ctx.storage.put<Pending>("link", {
            ...link,
            linked: { account: outcome.account, deviceId },
          });
          return { _tag: "Linked", account: outcome.account, deviceId };
        }
      }
    });
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private serially<A>(run: () => Promise<A>): Promise<A> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<Pending | undefined> {
    const link = await this.ctx.storage.get<Pending>("link");
    return link === undefined || link.expiresAt <= Date.now() ? undefined : link;
  }
}
