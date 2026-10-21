import {
  hashSecret,
  LINK_LIFETIME_MS,
  type AccountId,
  type AccountProfile,
  type ClaimLinkResponse,
  type ConfirmLinkRequest,
  type DeviceDraft,
  type DeviceId,
  type Installation,
  type LinkView,
} from "@cerium/protocol";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env.ts";

// One pending sign-in, named by its unguessable id. The machine that
// started it polls with its device secret until the user confirms it in their browser. It stays
// claimable until it expires, so a claim whose answer was lost can be made again.

interface Pending {
  readonly device: DeviceDraft;
  readonly secretHash: string;
  readonly installation?: Installation;
  readonly expiresAt: number;
  readonly linked?: {
    readonly account: AccountProfile;
    readonly deviceId: DeviceId;
  };
}

export type ConfirmOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly message: string };

export type ClaimOutcome = ClaimLinkResponse | "expired" | "forbidden";

export class Link extends DurableObject<Env> {
  private confirming: Promise<ConfirmOutcome> | undefined;

  async create(device: DeviceDraft, secretHash: string, installation?: Installation): Promise<number> {
    const expiresAt = Date.now() + LINK_LIFETIME_MS;
    await this.ctx.storage.put<Pending>("link", {
      device,
      secretHash,
      ...(installation === undefined ? {} : { installation }),
      expiresAt,
    });
    await this.ctx.storage.setAlarm(expiresAt);
    return expiresAt;
  }

  async view(): Promise<LinkView | undefined> {
    const link = await this.read();
    if (link === undefined) return undefined;
    return {
      device: link.device,
      status: link.linked === undefined ? "pending" : "confirmed",
      expiresAt: link.expiresAt,
    };
  }

  /** The user, signed in with Clerk, connects the machine to their account. */
  async confirm(accountId: AccountId, profile: ConfirmLinkRequest["profile"]): Promise<ConfirmOutcome> {
    // Two clicks on the page must not add the machine twice.
    this.confirming ??= this.link(accountId, profile).finally(() => {
      this.confirming = undefined;
    });
    return this.confirming;
  }

  async claim(secret: string): Promise<ClaimOutcome> {
    const link = await this.read();
    if (link === undefined) return "expired";
    if ((await hashSecret(secret)) !== link.secretHash) return "forbidden";
    return link.linked === undefined
      ? { _tag: "Pending" }
      : { _tag: "Linked", account: link.linked.account, deviceId: link.linked.deviceId };
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private async link(accountId: AccountId, profile: ConfirmLinkRequest["profile"]): Promise<ConfirmOutcome> {
    const link = await this.read();
    if (link === undefined) {
      return { ok: false, status: 410, message: "This sign-in link has expired. Start again from Cerium." };
    }
    if (link.linked !== undefined) {
      return link.linked.account.id === accountId
        ? { ok: true }
        : { ok: false, status: 409, message: "This machine was already connected to another account." };
    }
    const account = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(accountId));
    const deviceId = await account.link(accountId, link.device, link.secretHash, link.installation, profile);
    const linked = { account: { id: accountId, ...profile }, deviceId };
    await this.ctx.storage.put<Pending>("link", { ...link, linked });
    return { ok: true };
  }

  private async read(): Promise<Pending | undefined> {
    const link = await this.ctx.storage.get<Pending>("link");
    return link === undefined || link.expiresAt <= Date.now() ? undefined : link;
  }
}
