import { describe, expect, it } from "@effect/vitest";

import {
  rubberBand,
  SWIPE,
  swipeArmed,
  swipeIntent,
  swipeOffset,
  swipeRelease,
  type SwipeSides,
} from "../src/features/threads/SwipeableCard.tsx";
import { waitingLabel } from "../src/features/threads/WaitingCapsule.tsx";

const inbox: SwipeSides = { leading: true, trailing: 2, leadingCommits: true, trailingCommits: true };
const moreOnly: SwipeSides = { leading: false, trailing: 1, leadingCommits: false, trailingCommits: false };
const width = 360;

describe("swipeIntent", () => {
  it("waits until the touch has moved far enough", () => {
    expect(swipeIntent(8, 2, 200)).toBe("undecided");
  });

  it("takes a mostly horizontal move as a swipe", () => {
    expect(swipeIntent(-16, 6, 200)).toBe("horizontal");
    expect(swipeIntent(16, 6, 200)).toBe("horizontal");
  });

  it("leaves a mostly vertical move to the scroll", () => {
    expect(swipeIntent(12, 10, 200)).toBe("ignore");
    expect(swipeIntent(2, 14, 200)).toBe("ignore");
  });

  it("leaves a swipe right from the screen's edge to the system's Back", () => {
    expect(swipeIntent(20, 0, SWIPE.edge - 1)).toBe("ignore");
    expect(swipeIntent(-20, 0, SWIPE.edge - 1)).toBe("horizontal");
    expect(swipeIntent(20, 0, SWIPE.edge)).toBe("horizontal");
  });

  it("lets an open card be swiped from the edge", () => {
    expect(swipeIntent(20, 0, 4, false)).toBe("horizontal");
  });
});

describe("swipeOffset", () => {
  it("follows the finger up to the revealed actions", () => {
    expect(swipeOffset(60, inbox)).toBe(60);
    expect(swipeOffset(-140, inbox)).toBe(-140);
  });

  it("resists past them", () => {
    expect(rubberBand(SWIPE.reveal + 100, SWIPE.reveal)).toBeCloseTo(SWIPE.reveal + 35);
    expect(swipeOffset(-(2 * SWIPE.reveal + 100), inbox)).toBeCloseTo(-(2 * SWIPE.reveal + 35));
  });

  it("resists from the start toward a side with no action", () => {
    expect(swipeOffset(100, moreOnly)).toBeCloseTo(35);
  });
});

describe("swipeArmed", () => {
  it("arms past the commit share of the card's width", () => {
    expect(swipeArmed(width * SWIPE.commit - 1, width, inbox)).toBe(false);
    expect(swipeArmed(width * SWIPE.commit, width, inbox)).toBe(true);
    expect(swipeArmed(-width * SWIPE.commit, width, inbox)).toBe(true);
  });

  it("never arms a side with nothing to commit", () => {
    expect(swipeArmed(-width, width, moreOnly)).toBe(false);
  });
});

describe("swipeRelease", () => {
  it("commits a full swipe", () => {
    expect(swipeRelease(250, 110, 0, width, inbox)).toBe("commitLeading");
    expect(swipeRelease(-250, -160, 0, width, inbox)).toBe("commitTrailing");
  });

  it("springs back below half the reveal", () => {
    expect(swipeRelease(30, 30, 0, width, inbox)).toBe("close");
    expect(swipeRelease(-60, -60, 0, width, inbox)).toBe("close");
  });

  it("stays open past half the reveal", () => {
    expect(swipeRelease(50, 50, 0, width, inbox)).toBe("openLeading");
    expect(swipeRelease(-90, -90, 0, width, inbox)).toBe("openTrailing");
  });

  it("follows a fling either way", () => {
    expect(swipeRelease(-30, -30, -1, width, inbox)).toBe("openTrailing");
    expect(swipeRelease(-120, -120, 1, width, inbox)).toBe("close");
  });
});

describe("waitingLabel", () => {
  it("counts the threads waiting", () => {
    expect(waitingLabel(1)).toBe("1 thread waiting for you");
    expect(waitingLabel(3)).toBe("3 threads waiting for you");
  });
});
