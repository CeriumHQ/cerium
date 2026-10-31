import { Catalog, Checkpoints, Orchestrator, type OrchestratorError } from "@cerium/orchestrator";
import { LenientArray, type AgentInfo, type ThreadId } from "@cerium/protocol";
import { ReviewRecord, type FindingState, type ReviewerModel, type ReviewTarget } from "@cerium/rpc";
import { Context, Effect, FiberMap, FileSystem, Layer, Option, Path, PubSub, Schema, Stream } from "effect";
import { randomUUID } from "node:crypto";

import { isInside, resolveInside } from "./files.ts";
import { Git } from "./git.ts";
import {
  addedFile,
  defaultReviewer,
  readReview,
  reviewPrompt,
  splitFiles,
  type DiffFile,
} from "./reviewModel.ts";

// Reviews of a diff by an agent on another harness than the one that wrote it. Cerium reads the diff
// with the user's git, hands it to a read-only reviewer the orchestrator starts in the thread, and
// reads the reviewer's answer back as findings on the diff's lines, which the thread shows for the
// user to send to its agent or dismiss. Records are kept in a file, so a thread's reviews outlast a
// restart of the app.

/** A review Cerium couldn't start or change; `message` is written for the user. */
export class ReviewError extends Schema.TaggedError<ReviewError>()("ReviewError", {
  message: Schema.String,
}) {}

/** How long a reviewer may take before its review fails. */
const REVIEW_TIMEOUT = "20 minutes";
/** Reviews the file keeps, newest last. */
const KEPT = 200;
/** What a diff is read up to. */
const READ_LIMIT = 2 * 1024 * 1024;
/** Untracked files a review of the next commit reads, and how much of each. */
const NEW_FILES_READ = 40;
const NEW_FILE_BYTES = 64 * 1024;
/** Lines of context around each change: enough to judge it by. */
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-renames", "--unified=4"];
/** What `git hash-object -t tree /dev/null` names, to diff a repository without commits against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const ReviewFile = Schema.Struct({ reviews: LenientArray(ReviewRecord) });

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export class Reviews extends Context.Service<
  Reviews,
  {
    /** A thread's reviews, oldest first, now and after every change. */
    watch(threadId: ThreadId): Stream.Stream<ReadonlyArray<ReviewRecord>>;
    start(
      threadId: ThreadId,
      target: ReviewTarget,
      reviewer: ReviewerModel | undefined,
    ): Effect.Effect<ReviewRecord, ReviewError>;
    resolve(reviewId: string, findingId: string, state: FindingState): Effect.Effect<void, ReviewError>;
    stop(reviewId: string): Effect.Effect<void, ReviewError>;
  }
>()("cerium/backend/Reviews") {
  /** Keeps its records in `file`. Requires `Orchestrator`, `Catalog`, `Checkpoints`, `Git` and the file system. */
  static readonly layer = (options: { readonly file: string }) =>
    Layer.effect(
      Reviews,
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const catalog = yield* Catalog;
        const checkpoints = yield* Checkpoints;
        const git = yield* Git;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const records = new Map<string, ReviewRecord>();
        const changes = yield* PubSub.unbounded<ThreadId>();
        const running = yield* FiberMap.make<string>();
        const saving = yield* FiberMap.make<string>();

        // Reviews still running when the app last closed have lost their reviewer.
        const saved = yield* fs.readFileString(options.file).pipe(
          Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewFile))(text)),
          Effect.option,
        );
        for (const review of Option.match(saved, { onNone: () => [], onSome: (file) => file.reviews })) {
          records.set(
            review.id,
            review.state === "running"
              ? { ...review, state: "failed", message: "Cerium closed before the review finished." }
              : review,
          );
        }

        const persist = Effect.gen(function* () {
          const kept = [...records.values()].slice(-KEPT);
          const encoded = yield* Schema.encodeEffect(ReviewFile)({ reviews: kept });
          yield* fs.makeDirectory(path.dirname(options.file), { recursive: true });
          const scratch = `${options.file}.tmp`;
          yield* fs.writeFileString(scratch, JSON.stringify(encoded));
          yield* fs.rename(scratch, options.file);
        }).pipe(Effect.catch((error) => Effect.logWarning(`Couldn't save the reviews: ${String(error)}`)));

        const publish = (review: ReviewRecord) =>
          Effect.gen(function* () {
            yield* PubSub.publish(changes, review.threadId);
            yield* FiberMap.run(saving, "file", persist.pipe(Effect.delay("1 second")), {
              onlyIfMissing: true,
            });
          });

        const update = (id: string, change: (review: ReviewRecord) => ReviewRecord) =>
          Effect.gen(function* () {
            const current = records.get(id);
            if (current === undefined) return;
            const next = { ...change(current), updatedAt: Date.now() };
            records.set(id, next);
            yield* publish(next);
          });

        const ofThread = (threadId: ThreadId) =>
          [...records.values()]
            .filter((review) => review.threadId === threadId)
            .sort((a, b) => a.createdAt - b.createdAt);

        const find = (reviewId: string) =>
          Effect.fromNullishOr(records.get(reviewId)).pipe(
            Effect.mapError(() => new ReviewError({ message: "That review isn't known anymore." })),
          );

        // -------------------------------------------------------------------------------------
        // Diffs

        const failed = (message: string) => new ReviewError({ message });

        /** What git printed, or nothing when it failed. */
        const look = (cwd: string, args: ReadonlyArray<string>) =>
          git.run(cwd, args, { look: true, limit: READ_LIMIT }).pipe(
            Effect.map((result) => (result.code === 0 || result.truncated ? result.stdout : "")),
            Effect.orElseSucceed(() => ""),
          );

        const verified = (top: string, ref: string) =>
          look(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
            Effect.map((out) => (out.trim() === "" ? undefined : out.trim())),
          );

        const repository = (cwd: string) =>
          git.requireRepository(cwd).pipe(Effect.mapError((error) => failed(error.message)));

        /** What the next commit takes: what's staged, or everything when nothing is, new files included. */
        const changesDiff = Effect.fn("Reviews.changesDiff")(function* (root: string) {
          const { top } = yield* repository(root);
          const head = yield* verified(top, "HEAD");
          const staged = (yield* look(top, ["diff", "--cached", "--name-only"])).trim() !== "";
          const cached = staged || head === undefined;
          const patch = yield* look(top, [
            "diff",
            ...DIFF_FLAGS,
            ...(cached ? ["--cached"] : []),
            head ?? EMPTY_TREE,
          ]);
          const files = [...splitFiles(patch)];
          if (!cached) {
            const fresh = (yield* look(top, ["ls-files", "--others", "--exclude-standard"]))
              .split("\n")
              .filter((name) => name !== "");
            // An untracked link is read only where it leads inside the repository: what's outside it
            // isn't the change's to show another harness.
            const realTop = yield* fs.realPath(top).pipe(Effect.orElseSucceed(() => top));
            for (const name of fresh.slice(0, NEW_FILES_READ)) {
              const real = yield* fs.realPath(path.resolve(top, name)).pipe(Effect.option);
              if (Option.isNone(real) || !isInside(realTop, real.value)) continue;
              const text = yield* fs.stream(real.value, { bytesToRead: NEW_FILE_BYTES }).pipe(
                Stream.runCollect,
                Effect.map((chunks) => new TextDecoder().decode(Buffer.concat(chunks))),
                Effect.option,
              );
              if (Option.isSome(text) && !text.value.includes("\0")) files.push(addedFile(name, text.value));
            }
          }
          const count = plural(files.length, "file");
          return { files, label: staged ? `${count} staged` : `${count} changed`, cwd: top };
        });

        /** The branch's commits that `base` doesn't have, as a pull request would show them. */
        const branchDiff = Effect.fn("Reviews.branchDiff")(function* (cwd: string, base: string) {
          const { top } = yield* repository(cwd);
          let baseRef: string | undefined;
          for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`, base]) {
            if ((yield* verified(top, ref)) !== undefined) {
              baseRef = ref;
              break;
            }
          }
          if (baseRef === undefined) return yield* failed(`There's no branch ${base} here to compare with.`);
          const fork = (yield* look(top, ["merge-base", baseRef, "HEAD"])).trim();
          if (fork === "") return yield* failed(`The branch shares no history with ${base}.`);
          const files = splitFiles(yield* look(top, ["diff", ...DIFF_FLAGS, fork, "HEAD"]));
          const branch = (yield* look(top, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "This branch";
          return { files, label: `${branch} against ${base}`, cwd: top };
        });

        /** The files one of an agent's turns changed, from the folder's snapshots. */
        const turnDiff = Effect.fn("Reviews.turnDiff")(function* (
          target: Extract<ReviewTarget, { readonly _tag: "Turn" }>,
        ) {
          const files: Array<DiffFile> = [];
          for (const name of target.paths) {
            if (resolveInside(target.root, name) === undefined) continue;
            const patch = yield* checkpoints
              .diff(target.root, target.before, target.after, name, 4)
              .pipe(Effect.orElseSucceed(() => ""));
            const [file] = splitFiles(patch);
            if (file !== undefined) files.push({ ...file, path: name });
          }
          return { files, label: `${plural(files.length, "file")} one turn changed`, cwd: target.root };
        });

        const diffOf = (target: ReviewTarget) =>
          target._tag === "Changes"
            ? changesDiff(target.root)
            : target._tag === "Branch"
              ? branchDiff(target.cwd, target.base)
              : turnDiff(target);

        // -------------------------------------------------------------------------------------
        // Reviewing

        const leadOf = (threadId: ThreadId) =>
          orchestrator.listAgents(threadId).pipe(
            Effect.map((agents) => agents.find((agent) => agent.parentId === undefined)),
            Effect.mapError((error) => failed(error.message)),
          );

        const start = Effect.fn("Reviews.start")(function* (
          threadId: ThreadId,
          target: ReviewTarget,
          picked: ReviewerModel | undefined,
        ) {
          const live = ofThread(threadId).find(
            (review) => review.state === "running" && sameTarget(review.target, target),
          );
          if (live !== undefined) return live;
          const lead: AgentInfo | undefined = yield* leadOf(threadId);
          const reviewer =
            picked ?? (lead === undefined ? undefined : defaultReviewer(yield* catalog.entries, lead));
          if (reviewer === undefined) {
            return yield* failed("Put a model on your roster in Settings → Roster to review with.");
          }
          const { files, label } = yield* diffOf(target);
          const reviewable = files.filter((file) => file.binary || file.hunks.length > 0);
          if (reviewable.length === 0) return yield* failed("There's nothing to review.");

          const createdAt = Date.now();
          const id = `rev_${randomUUID()}`;
          const record: ReviewRecord = {
            id,
            threadId,
            target,
            label,
            files: reviewable.map((file) => file.path),
            reviewer,
            createdAt,
            updatedAt: createdAt,
            state: "running",
            findings: [],
          };
          records.set(id, record);
          const prompt = reviewPrompt({
            label,
            author: lead === undefined ? undefined : `${lead.model} (${lead.provider})`,
            files: reviewable,
          });
          const started = yield* orchestrator.startReview(threadId, reviewer, prompt).pipe(
            Effect.tapError(() => Effect.sync(() => records.delete(id))),
            Effect.mapError((error) => failed(error.message)),
          );
          yield* update(id, (review) => ({ ...review, agentId: started.agentId }));

          const finish = started.reply.pipe(
            Effect.timeoutOrElse({
              duration: REVIEW_TIMEOUT,
              orElse: () =>
                Effect.andThen(
                  orchestrator.stopAgent(started.agentId).pipe(Effect.ignore),
                  Effect.fail({ message: "The reviewer took too long and was stopped." }),
                ),
            }),
            Effect.matchEffect({
              onSuccess: (reply) =>
                update(id, (review) => {
                  const { summary, findings } = readReview(reply, reviewable);
                  return {
                    ...review,
                    state: "done",
                    ...(summary === undefined ? {} : { summary }),
                    findings,
                  };
                }),
              onFailure: (error: OrchestratorError | { readonly message: string }) =>
                update(id, (review) =>
                  review.state === "stopped"
                    ? review
                    : { ...review, state: "failed", message: error.message },
                ),
            }),
          );
          yield* FiberMap.run(running, id, finish);
          return records.get(id) ?? record;
        });

        const resolve = Effect.fn("Reviews.resolve")(function* (
          reviewId: string,
          findingId: string,
          state: FindingState,
        ) {
          const review = yield* find(reviewId);
          if (!review.findings.some((finding) => finding.id === findingId)) {
            return yield* failed("That finding isn't known anymore.");
          }
          yield* update(reviewId, (current) => ({
            ...current,
            findings: current.findings.map((finding) =>
              finding.id === findingId ? { ...finding, state } : finding,
            ),
          }));
        });

        const stop = Effect.fn("Reviews.stop")(function* (reviewId: string) {
          const review = yield* find(reviewId);
          if (review.state !== "running") return;
          yield* update(reviewId, (current) => ({ ...current, state: "stopped", message: "Stopped." }));
          if (review.agentId !== undefined) yield* orchestrator.stopAgent(review.agentId).pipe(Effect.ignore);
        });

        return Reviews.of({
          watch: (threadId) =>
            Stream.unwrap(
              Effect.gen(function* () {
                // Subscribed before the first reading, so no change falls between the two.
                const subscription = yield* PubSub.subscribe(changes);
                return Stream.concat(
                  Stream.succeed(threadId),
                  Stream.fromSubscription(subscription).pipe(
                    Stream.filter((changed) => changed === threadId),
                  ),
                ).pipe(Stream.map(() => ofThread(threadId)));
              }),
            ),
          start,
          resolve,
          stop,
        });
      }),
    );
}

/** Two targets that read the same diff. */
const sameTarget = (a: ReviewTarget, b: ReviewTarget): boolean => {
  if (a._tag === "Changes" && b._tag === "Changes") return a.root === b.root;
  if (a._tag === "Branch" && b._tag === "Branch") return a.cwd === b.cwd && a.base === b.base;
  if (a._tag === "Turn" && b._tag === "Turn") return a.turnId === b.turnId && a.after === b.after;
  return false;
};
