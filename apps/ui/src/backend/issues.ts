import type { IssueFilters } from "@cerium/rpc";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { ITEMS_STEP, NO_FILTERS, filtersOfKey } from "../features/issues/model.ts";
import { Backend, connectionAtom } from "./client.ts";

// The Issues tab's and the issue viewer's reads of a repository's issues, through the machine that
// runs the thread. Each read is an atom keyed by the folder (`cwd`, the work thread's) and what it
// asks for, and starts over when its version atom counts up: an action of the user's, the window
// coming back to the front, or the machine saying the issue changed.

const key = (...parts: ReadonlyArray<string>) => parts.join("\n");

// ---------------------------------------------------------------------------------------------
// The list

/** Counts up whenever a folder's issues may have changed, so every page of its list is read again. */
export const issueListVersionAtom = Atom.family((_cwd: string) => Atom.make(0).pipe(Atom.keepAlive));

/** What the Issues tab filters a folder's issues by; kept while the window is open. */
export const issueFiltersAtom = Atom.family((_cwd: string) =>
  Atom.make<IssueFilters>(NO_FILTERS).pipe(Atom.keepAlive),
);

/** A page of a folder's issues, keyed `cwd`, the filters (see `filtersKey`) and where the page starts. */
export const issuePageKey = (cwd: string, filters: string, after: string | undefined) =>
  key(cwd, filters, after ?? "");

export const issuePageAtom = Atom.family((id: string) => {
  const [cwd = "", filters = "{}", after = ""] = id.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(issueListVersionAtom(cwd));
      return Backend.use((client) =>
        client("ListIssues", { cwd, filters: filtersOfKey(filters), ...(after === "" ? {} : { after }) }),
      );
    })
    .pipe(Atom.setIdleTTL("1 minute"));
});

/** The labels and milestones a folder's repository offers, and who is signed in. */
export const issueChoicesAtom = Atom.family((cwd: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      return Backend.use((client) => client("IssueChoices", { cwd }));
    })
    .pipe(Atom.setIdleTTL("5 minutes")),
);

export const refreshIssueList = (registry: AtomRegistry.AtomRegistry, cwd: string) =>
  registry.update(issueListVersionAtom(cwd), (count) => count + 1);

// ---------------------------------------------------------------------------------------------
// One issue

/** Keys an issue by its folder and number. */
export const issueKey = (cwd: string, number: number) => key(cwd, String(number));

/** Counts up whenever an issue may have changed, so it is read again. */
export const issueVersionAtom = Atom.family((_id: string) => Atom.make(0).pipe(Atom.keepAlive));

/** How many entries of the conversation the viewer wants; reading on adds a step. */
export const issueItemsAtom = Atom.family((_id: string) => Atom.make(ITEMS_STEP).pipe(Atom.keepAlive));

/** An issue with the first entries of its conversation, keyed with `issueKey`. */
export const issueAtom = Atom.family((id: string) => {
  const [cwd = "", number = "0"] = id.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(issueVersionAtom(id));
      const items = get(issueItemsAtom(id));
      return Backend.use((client) => client("Issue", { cwd, number: Number(number), items }));
    })
    .pipe(Atom.setIdleTTL("30 seconds"));
});

export const refreshIssue = (registry: AtomRegistry.AtomRegistry, id: string) =>
  registry.update(issueVersionAtom(id), (count) => count + 1);

/** The comment being written on an issue, kept while the window is open so a tab switch loses nothing. */
export const issueDraftAtom = Atom.family((_id: string) => Atom.make("").pipe(Atom.keepAlive));

/** Asks for another step of the conversation. */
export const readOnIssue = (registry: AtomRegistry.AtomRegistry, id: string, limit: number) =>
  registry.update(issueItemsAtom(id), (items) => Math.min(items + ITEMS_STEP, limit));

// ---------------------------------------------------------------------------------------------
// Doing things

export const isIssueChanged = Backend.mutation("IssueChanged");
export const commentOnIssue = Backend.mutation("AddGitHubComment");
export const closeIssue = Backend.mutation("CloseIssue");
export const reopenIssue = Backend.mutation("ReopenIssue");
export const updateIssue = Backend.mutation("UpdateIssue");
export const createIssue = Backend.mutation("CreateIssue");
/** An issue a quick model wrote up from the user's notes. */
export const draftIssue = Backend.mutation("DraftIssue");
