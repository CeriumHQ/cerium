import type { AgentId, Attachment, FromUser, InputItem } from "@cerium/protocol";
import { Effect, Option, Queue } from "effect";

import type { AgentSessions } from "./agentSessions.ts";
import type { OrchestratorContext } from "./context.ts";
import { notAllowed, notFound, OrchestratorError, unavailable } from "./errors.ts";
import type { UserMessageExtras } from "./inputs.ts";
import { liveEvents, undeliveredIds } from "./rewind.ts";
import type { Rewinding } from "./rewinding.ts";
import type { Runtime } from "./runtime.ts";

/**
 * What reaches an agent's inbox from outside its team: the user's messages (and taking one back
 * before it is delivered), and Cerium's notices, held for its next turn or waking it.
 */
export const makeInbox = (ctx: OrchestratorContext, sessions: AgentSessions, rewinding: Rewinding) => {
  const {
    store,
    titles,
    layerScope,
    runtimes,
    messageDelivery,
    untitled,
    held,
    forAgent,
    agentInfo,
    makeId,
    emit,
    emitStored,
    holdNotice,
    endPause,
    updateThread,
  } = ctx;
  const { liveLead } = sessions;
  const { rewind } = rewinding;

  /**
   * Names a new thread from its first message while the lead works on it, unless the user
   * renamed the thread meanwhile. The lead's live feed tells the lists at once.
   */
  const nameThread = (
    lead: Runtime,
    startedAs: string,
    text: string,
    attachments: ReadonlyArray<Attachment>,
  ) =>
    Effect.gen(function* () {
      const { threadId, provider, model } = lead.info;
      const title = yield* titles.name({
        agentId: lead.info.id,
        text,
        attachments: attachments.map((attachment) => attachment.name),
        lead: { provider, model },
      });
      if (Option.isNone(title)) return;
      const thread = yield* store.getThread(threadId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(thread) || thread.value.title !== startedAs) return;
      yield* updateThread(threadId, { title: title.value });
      yield* emit(lead, { _tag: "ThreadRenamed", title: title.value });
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Couldn't name a thread", cause)));

  /**
   * The user's message to a lead; one a lead wrote for them when it started the thread says so.
   * With `rewindBefore`, the conversation first goes back to before that earlier message.
   */
  const acceptUserMessage = (
    agentId: AgentId,
    text: string,
    extras: UserMessageExtras & Pick<FromUser, "writtenBy"> = {},
    options: { readonly rewindBefore?: string } = {},
  ) => {
    const { attachments = [], mentions = [], writtenBy, sentVia } = extras;
    if (text.trim() === "" && attachments.length === 0) {
      return Effect.fail(new OrchestratorError({ reason: "invalid", message: "The message is empty." }));
    }
    return forAgent(agentId)(
      Effect.gen(function* () {
        if (options.rewindBefore !== undefined) yield* rewind(agentId, options.rewindBefore);
        const { rt, undelivered, notices } = yield* liveLead(agentId);
        // A message to a paused lead is sent at once: the user may know the limit is lifted.
        yield* endPause(rt, "message");
        const message: FromUser = {
          _tag: "FromUser",
          id: yield* makeId("msg"),
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(mentions.length > 0 ? { mentions } : {}),
          ...(writtenBy ? { writtenBy } : {}),
          ...(sentVia ? { sentVia } : {}),
        };
        // Recorded before it waits on the session or a running turn, so the user sees it at once.
        messageDelivery.userTurn(rt.info.threadId);
        yield* emit(rt, { _tag: "MessageQueued", message });
        // Offered together, so the user's messages and any notices make one turn.
        // A turn in progress takes it at its next step, between tool calls. Marked first: the turn
        // loop clears the mark when it takes the inbox.
        rt.userWaiting = true;
        yield* Queue.offerAll(rt.inbox, [...undelivered, message, ...notices]);
        const startedAs = untitled.get(rt.info.threadId);
        untitled.delete(rt.info.threadId);
        if (startedAs !== undefined && text.trim() !== "") {
          yield* Effect.forkIn(nameThread(rt, startedAs, text, attachments), layerScope);
        }
      }),
    );
  };

  const sendUserMessage = (agentId: AgentId, text: string, extras: UserMessageExtras = {}) =>
    acceptUserMessage(agentId, text, {
      ...(extras.attachments ? { attachments: extras.attachments } : {}),
      ...(extras.mentions ? { mentions: extras.mentions } : {}),
      ...(extras.sentVia ? { sentVia: extras.sentVia } : {}),
    });

  const editMessage = (agentId: AgentId, messageId: string, text: string, extras: UserMessageExtras = {}) =>
    acceptUserMessage(
      agentId,
      text,
      {
        ...(extras.attachments ? { attachments: extras.attachments } : {}),
        ...(extras.mentions ? { mentions: extras.mentions } : {}),
      },
      { rewindBefore: messageId },
    );

  // Under the accept permit, so a message being accepted can't slip between taking the inbox
  // and putting the rest back.

  const withdrawMessage = (agentId: AgentId, messageId: string) =>
    forAgent(agentId)(
      Effect.gen(function* () {
        const isIt = (item: InputItem) => item._tag === "FromUser" && item.id === messageId;
        const live = runtimes.get(agentId);
        const session = live !== undefined && !live.ended ? live : undefined;
        // A lead picked back up after a rewind holds what waited for the user's next message.
        const kept = held.get(agentId);
        let found = kept?.undelivered.some(isIt) === true;
        if (found && kept !== undefined) {
          held.set(agentId, { ...kept, undelivered: kept.undelivered.filter((item) => !isIt(item)) });
        }
        if (!found && session !== undefined) {
          // Only what still waits in the inbox: one the turn loop has taken is on its way in.
          const waiting = yield* Queue.clear(session.inbox);
          const rest = waiting.filter((item) => !isIt(item));
          found = rest.length < waiting.length;
          yield* Queue.offerAll(session.inbox, rest);
          // Nothing left of the user's to steer the running turn for.
          if (found) session.userWaiting = rest.some((item) => item._tag === "FromUser");
        }
        if (!found && session === undefined) {
          // A lead without a session keeps what it never took in its history, for its next one.
          const events = liveEvents(
            yield* store
              .listEvents(agentId, {
                tags: ["MessageQueued", "MessageWithdrawn", "TurnInput", "ConversationRewound"],
              })
              .pipe(Effect.mapError(unavailable)),
          );
          found = undeliveredIds(events).has(messageId);
        }
        if (!found) return false;
        const withdrawn = { _tag: "MessageWithdrawn", messageId } as const;
        if (session !== undefined) yield* emit(session, withdrawn);
        else {
          const info = yield* agentInfo(agentId);
          yield* emitStored(info, withdrawn);
        }
        return true;
      }),
    );

  const notify = (agentId: AgentId, text: string) =>
    Effect.gen(function* () {
      const rt = runtimes.get(agentId);
      if (rt === undefined || rt.ended) return;
      const id = yield* makeId("notice");
      yield* emit(rt, { _tag: "NoticeHeld", id, text }).pipe(
        Effect.catch((error) => Effect.logWarning(`Could not save informational notice: ${error.message}`)),
      );
      holdNotice(agentId, { _tag: "SystemNotice", id, text });
    });

  const wake = (agentId: AgentId, text: string) =>
    forAgent(agentId)(
      Effect.gen(function* () {
        const notice: InputItem = { _tag: "SystemNotice", text };
        const live = runtimes.get(agentId);
        if (live !== undefined && !live.ended) return yield* Queue.offer(live.inbox, notice);
        const stored = Option.getOrUndefined(
          yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable)),
        );
        if (stored === undefined) return yield* notFound(`Agent ${agentId} does not exist.`);
        if (stored.parentId !== undefined) {
          return yield* notAllowed("That agent has ended: tell the thread's lead instead.");
        }
        const { rt, undelivered, notices } = yield* liveLead(agentId);
        yield* Queue.offerAll(rt.inbox, [...undelivered, notice, ...notices]);
      }),
    ).pipe(Effect.asVoid);

  return {
    acceptUserMessage,
    sendUserMessage,
    editMessage,
    withdrawMessage,
    notify,
    wake,
  };
};

export type Inbox = ReturnType<typeof makeInbox>;
