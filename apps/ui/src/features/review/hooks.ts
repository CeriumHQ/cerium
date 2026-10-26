import { rosterMembers, type ProviderId, type ThreadId } from "@cerium/protocol";
import type { ReviewRecord } from "@cerium/rpc";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";

import { accountAtom, harnessesAtom, settingsAtom, threadsAtom } from "../../backend/atoms.ts";
import { machineAtom } from "../../backend/machine.ts";
import { REVIEWS_VERSION, reviewsAtom } from "../../backend/reviews.ts";
import { leadOf, modelLabel } from "../../backend/view.ts";
import { remember, stored } from "../../lib/storage.ts";
import { useModels } from "../composer/models.ts";
import { chosenReviewer, reviewerKey, reviewerOptions, type ReviewerOption } from "./model.ts";

const REVIEWER_KEY = "cerium:reviewer";

/** The model the user last picked to review with, kept across threads and restarts. */
const pickedReviewerAtom = Atom.make<string | undefined>(stored(REVIEWER_KEY)).pipe(Atom.keepAlive);

/** Whether the machine the window drives can review: this computer always, another from `REVIEWS_VERSION`. */
export const useReviewsOffered = (): boolean => {
  const machine = useAtomValue(machineAtom);
  const account = AsyncResult.getOrElse(useAtomValue(accountAtom), () => undefined);
  if (machine === undefined) return true;
  const device =
    account?._tag === "SignedIn" ? account.devices.find((each) => each.id === machine.id) : undefined;
  return (device?.rpcVersion ?? 0) >= REVIEWS_VERSION;
};

/** A thread's reviews, oldest first; none while they're read. */
export const useThreadReviews = (threadId: ThreadId): ReadonlyArray<ReviewRecord> =>
  AsyncResult.getOrElse(useAtomValue(reviewsAtom(threadId)), (): ReadonlyArray<ReviewRecord> => []);

/** Names a model as the harnesses list it. */
export const useModelLabel = () => {
  const models = useModels();
  return (provider: ProviderId, model: string) => modelLabel(models, provider, model);
};

/**
 * The models a review of the thread's work may run on (the roster's, those on another harness than
 * its lead's first), the one it runs on, and the way to pick another.
 */
export const useReviewers = (
  threadId: ThreadId,
): {
  readonly options: ReadonlyArray<ReviewerOption>;
  readonly chosen: ReviewerOption | undefined;
  readonly pick: (option: ReviewerOption) => void;
} => {
  const models = useModels();
  const settings = AsyncResult.getOrElse(useAtomValue(settingsAtom), () => undefined);
  const harnesses = AsyncResult.getOrElse(useAtomValue(harnessesAtom), () => []);
  const threads = AsyncResult.getOrElse(useAtomValue(threadsAtom), () => []);
  const [picked, setPicked] = useAtom(pickedReviewerAtom);
  const ready = new Set(
    harnesses.flatMap((status) =>
      status._tag === "HarnessMissing" || status.auth._tag === "LoggedOut" ? [] : [status.provider],
    ),
  );
  const lead = leadOf(threads.find((overview) => overview.thread.id === threadId)?.agents ?? []);
  const members = rosterMembers(settings?.roster ?? { models: [], edited: [] }, models);
  const options = reviewerOptions(members, ready, lead?.provider);
  return {
    options,
    chosen: chosenReviewer(options, picked),
    pick: (option) => {
      const key = reviewerKey(option.reviewer);
      remember(REVIEWER_KEY, key);
      setPicked(key);
    },
  };
};
