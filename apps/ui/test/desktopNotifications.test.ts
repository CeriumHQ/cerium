import { NOTIFICATION_KINDS, type ThreadId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { handling } from "../src/desktop/model.ts";

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

describe("a usage limit notification", () => {
  const limit = { kind: "limit" as const };

  it("shows whatever the user looks at, as no open page tells them", () => {
    expect(handling(limit, NOTIFICATION_KINDS, { atWindow: false, viewing: undefined })).toBe("show");
    expect(handling(limit, NOTIFICATION_KINDS, { atWindow: true, viewing: "thr_1" })).toBe("show");
  });

  it("does nothing once the user turned it off", () => {
    expect(handling(limit, ["needsYou", "finished", "failed"], { atWindow: false, viewing: undefined })).toBe(
      "ignore",
    );
  });
});
