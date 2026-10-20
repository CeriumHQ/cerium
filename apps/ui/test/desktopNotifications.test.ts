import { NOTIFICATION_KINDS, type ThreadId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { badgeText, handling } from "../src/desktop/model.ts";

const finished = { threadId: "thr_1" as ThreadId, kind: "finished" as const };

describe("a desktop notification", () => {
  it("shows while the user is away from the window, whichever thread it shows", () => {
    expect(handling(finished, NOTIFICATION_KINDS, { atWindow: false, viewing: undefined })).toBe("show");
    expect(handling(finished, NOTIFICATION_KINDS, { atWindow: false, viewing: "thr_1" })).toBe("show");
  });

  it("only counts while the user is at the window in another thread", () => {
    expect(handling(finished, NOTIFICATION_KINDS, { atWindow: true, viewing: "thr_2" })).toBe("count");
    expect(handling(finished, NOTIFICATION_KINDS, { atWindow: true, viewing: undefined })).toBe("count");
  });

  it("does nothing for the thread the user is looking at, or a kind they turned off", () => {
    expect(handling(finished, NOTIFICATION_KINDS, { atWindow: true, viewing: "thr_1" })).toBe("ignore");
    expect(handling(finished, ["needsYou", "failed"], { atWindow: false, viewing: undefined })).toBe(
      "ignore",
    );
    expect(handling(finished, [], { atWindow: false, viewing: undefined })).toBe("ignore");
  });
});

describe("the taskbar badge", () => {
  it("reads the count up to nine", () => {
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9)).toBe("9");
    expect(badgeText(12)).toBe("9+");
  });
});
