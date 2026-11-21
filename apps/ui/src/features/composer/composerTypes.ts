import type {
  AccessMode,
  Attachment,
  Mention,
  ModelSpeed,
  ProviderId,
  ReasoningEffort,
  WorkspaceChoice,
} from "@cerium/protocol";

import type { AgentContext } from "../agents/model.ts";
import type { Followup } from "./followup.ts";
import type { HandoffChoice, ModelSwitch } from "./models.ts";
import type { LimitChoice } from "./Pickers.tsx";
import type { AskSide } from "./SideQuestion.tsx";

// What the message box sends, what it sends to, and what the window asks of it (Composer.tsx).

/** A message as the box sends it: its text, which names each mention by its token. */
export interface OutgoingMessage {
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly mentions: ReadonlyArray<Mention>;
}

/** What a new thread starts with. */
export interface ThreadSetup {
  readonly provider: ProviderId;
  readonly model: string;
  /** Absent for models the harness offers no effort setting for. */
  readonly effort?: ReasoningEffort;
  /** The effort router picks the lead's effort each turn, starting from `effort`. */
  readonly autoEffort?: boolean;
  /** Absent for models served at one speed. */
  readonly speed?: ModelSpeed;
  readonly access: AccessMode;
  /** A work thread runs in a git worktree of its own. */
  readonly worktree?: boolean;
  readonly workspace?: WorkspaceChoice;
}

export type ComposerTarget =
  /** Messages go to an existing thread's lead. */
  | {
      readonly kind: "thread";
      readonly provider: ProviderId;
      /** The model as the transcript names it, for when the harness no longer lists it. */
      readonly model: string;
      /** The model as the harness lists it, which the picker matches. */
      readonly modelId: string;
      /** Absent for models the harness offers no effort setting for. */
      readonly effort?: ReasoningEffort | undefined;
      /** The effort router picks the lead's effort each turn. */
      readonly autoEffort?: boolean | undefined;
      /** Absent for a lead at its harness's default speed. */
      readonly speed?: ModelSpeed | undefined;
      /** The thread's folder, which `@` tags files from; absent for chats. */
      readonly folder?: string | undefined;
      /** The thread's own worktree's branch, and the branch it was made from. */
      readonly worktree?:
        | {
            readonly branch: string;
            readonly base: string;
            readonly root: string;
            readonly project: string;
          }
        | undefined;
      /** The lead stopped or failed; the next message picks the thread back up. */
      readonly ended?: "stopped" | "failed";
      /**
       * Switches the lead to another model of its harness, or another effort or speed, from its next turn.
       * Resolves false when it didn't go through. Absent where the box can't ask for that.
       */
      readonly onSwitch?: (choice: ModelSwitch) => Promise<boolean>;
      /** The lead's context as its harness last measured it; absent where it reports none. */
      readonly context?: AgentContext | undefined;
      /** Asks the lead's harness to compact its conversation, offered where the harness can. */
      readonly onCompact?: () => void;
      /** What the thread does when its harness's usage runs out, and sets it; absent where it can't be set. */
      readonly onLimit?: LimitChoice;
      /**
       * Answers a quick question about the thread from its conversation, without adding it to the
       * thread (`/btw`). Absent where the machine can't.
       */
      readonly onAskSide?: AskSide;
      /**
       * What the empty box needs to suggest a follow-up after a turn the lead finishes in view; absent
       * where the machine can't suggest one.
       */
      readonly followup?: Followup;
      /**
       * Hands the lead to a model of another harness, which the user confirms first; its model menu
       * then lists every harness. Absent where the machine can't.
       */
      readonly handoff?: {
        /** Harnesses installed and signed in. */
        readonly available: ReadonlySet<ProviderId>;
        /** How many of the agents the lead spawned still run. */
        readonly agents: number;
        /** Resolves false when it didn't go through. */
        readonly onHandOff: (choice: HandoffChoice) => Promise<boolean>;
      };
    }
  /** The first message starts a thread with the chosen setup. */
  | {
      readonly kind: "new";
      readonly mode: "work" | "chat";
      /** Work threads need a folder before they can start. */
      readonly folder: string | undefined;
      readonly onChooseFolder: (folder: string) => void;
      /** Providers whose harness is installed and logged in. */
      readonly available: ReadonlySet<ProviderId>;
      /** The machine can give a thread a worktree of its own. */
      readonly worktrees?: boolean;
      readonly workspaceControls?: boolean;
    };

export interface ComposerCommands {
  readonly openModels: () => boolean;
  readonly steerNow: () => boolean;
}
