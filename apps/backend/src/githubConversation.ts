import type {
  ConversationCommit,
  ConversationItem,
  GitHubAssociation,
  GitHubLabel,
  GitHubReaction,
  GitHubReference,
  GitHubUser,
  ReactionKind,
  ReviewState,
} from "@cerium/rpc";

// Reading GitHub's GraphQL answers about pull requests' and issues' conversations: the people, labels
// and reactions in them, and each entry of a timeline as the conversation shows it. Plain functions,
// so they can be tested against real answers; the pull requests' and the issues' readers share them.

export type Json = Readonly<Record<string, unknown>>;

export const json = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;

export const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export const whole = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

export const flag = (value: unknown): boolean => value === true;

/** An ISO time as milliseconds. */
export const time = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
};

/** The objects of a connection's `nodes`; a `null` among them (an item GitHub hid) is skipped. */
export const nodesOf = (connection: unknown): ReadonlyArray<Json> => {
  const nodes: unknown = json(connection)?.["nodes"];
  return (Array.isArray(nodes) ? nodes : []).flatMap((node) => {
    const each = json(node);
    return each === undefined ? [] : [each];
  });
};

/** A connection's cursor for the page after this one; none on the last. */
export const nextCursor = (connection: unknown): string | undefined => {
  const info = json(json(connection)?.["pageInfo"]);
  const cursor = text(info?.["endCursor"]);
  return info?.["hasNextPage"] === true ? cursor : undefined;
};

// ---------------------------------------------------------------------------------------------
// GraphQL's fields

export const ACTOR = "login avatarUrl";

export const REACTIONS = "reactionGroups { content viewerHasReacted reactors { totalCount } }";

export const LABEL = "name color description";

const REFERENCE =
  "__typename ... on Issue { number title url repository { nameWithOwner } } ... on PullRequest { number title url repository { nameWithOwner } }";

const ASSIGNEE =
  "assignee { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } }";

const COMMENT = `id body createdAt lastEditedAt isMinimized minimizedReason authorAssociation url author { ${ACTOR} } ${REACTIONS}`;

/** The kinds of timeline entry an issue's and a pull request's conversations both have. */
export const SHARED_TIMELINE_TYPES = [
  "ISSUE_COMMENT",
  "LABELED_EVENT",
  "UNLABELED_EVENT",
  "ASSIGNED_EVENT",
  "UNASSIGNED_EVENT",
  "CLOSED_EVENT",
  "REOPENED_EVENT",
  "RENAMED_TITLE_EVENT",
  "MILESTONED_EVENT",
  "DEMILESTONED_EVENT",
  "CROSS_REFERENCED_EVENT",
  "REFERENCED_EVENT",
  "LOCKED_EVENT",
  "UNLOCKED_EVENT",
  "CONNECTED_EVENT",
  "DISCONNECTED_EVENT",
  "MARKED_AS_DUPLICATE_EVENT",
  "TRANSFERRED_EVENT",
];

/** Those kinds' fields, inside a timeline connection's `nodes`. */
export const SHARED_TIMELINE_FIELDS = `
    __typename
    ... on IssueComment { ${COMMENT} }
    ... on LabeledEvent { createdAt actor { ${ACTOR} } label { ${LABEL} } }
    ... on UnlabeledEvent { createdAt actor { ${ACTOR} } label { ${LABEL} } }
    ... on AssignedEvent { createdAt actor { ${ACTOR} } ${ASSIGNEE} }
    ... on UnassignedEvent { createdAt actor { ${ACTOR} } ${ASSIGNEE} }
    ... on ClosedEvent { createdAt actor { ${ACTOR} } stateReason closer { __typename ... on PullRequest { number url } ... on Commit { abbreviatedOid url } } }
    ... on ReopenedEvent { createdAt actor { ${ACTOR} } }
    ... on RenamedTitleEvent { createdAt actor { ${ACTOR} } previousTitle currentTitle }
    ... on MilestonedEvent { createdAt actor { ${ACTOR} } milestoneTitle }
    ... on DemilestonedEvent { createdAt actor { ${ACTOR} } milestoneTitle }
    ... on CrossReferencedEvent { createdAt actor { ${ACTOR} } isCrossRepository willCloseTarget source { ${REFERENCE} } }
    ... on ReferencedEvent { createdAt actor { ${ACTOR} } commit { abbreviatedOid messageHeadline url } }
    ... on LockedEvent { createdAt actor { ${ACTOR} } lockReason }
    ... on UnlockedEvent { createdAt actor { ${ACTOR} } }
    ... on ConnectedEvent { createdAt actor { ${ACTOR} } subject { ${REFERENCE} } }
    ... on DisconnectedEvent { createdAt actor { ${ACTOR} } subject { ${REFERENCE} } }
    ... on MarkedAsDuplicateEvent { createdAt actor { ${ACTOR} } canonical { ${REFERENCE} } }
    ... on TransferredEvent { createdAt actor { ${ACTOR} } fromRepository { nameWithOwner } }`;

/** The kinds only a pull request's conversation has. */
export const PULL_REQUEST_TIMELINE_TYPES = [
  "PULL_REQUEST_REVIEW",
  "PULL_REQUEST_COMMIT",
  "REVIEW_REQUESTED_EVENT",
  "REVIEW_REQUEST_REMOVED_EVENT",
  "MERGED_EVENT",
  "READY_FOR_REVIEW_EVENT",
  "CONVERT_TO_DRAFT_EVENT",
  "HEAD_REF_FORCE_PUSHED_EVENT",
  "HEAD_REF_DELETED_EVENT",
  "HEAD_REF_RESTORED_EVENT",
  "BASE_REF_CHANGED_EVENT",
];

const REVIEWER =
  "requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } }";

export const PULL_REQUEST_TIMELINE_FIELDS = `
    ... on PullRequestReview { ${COMMENT} state submittedAt }
    ... on PullRequestCommit { commit { oid messageHeadline committedDate url author { name user { ${ACTOR} } } } }
    ... on ReviewRequestedEvent { createdAt actor { ${ACTOR} } ${REVIEWER} }
    ... on ReviewRequestRemovedEvent { createdAt actor { ${ACTOR} } ${REVIEWER} }
    ... on MergedEvent { createdAt actor { ${ACTOR} } mergeRefName commit { oid url } }
    ... on ReadyForReviewEvent { createdAt actor { ${ACTOR} } }
    ... on ConvertToDraftEvent { createdAt actor { ${ACTOR} } }
    ... on HeadRefForcePushedEvent { createdAt actor { ${ACTOR} } beforeCommit { abbreviatedOid } afterCommit { abbreviatedOid } }
    ... on HeadRefDeletedEvent { createdAt actor { ${ACTOR} } }
    ... on HeadRefRestoredEvent { createdAt actor { ${ACTOR} } }
    ... on BaseRefChangedEvent { createdAt actor { ${ACTOR} } previousRefName currentRefName }`;

// ---------------------------------------------------------------------------------------------
// People, labels and reactions

export const user = (value: unknown): GitHubUser | undefined => {
  const each = json(value);
  const login = text(each?.["login"]);
  if (login === undefined || login === "") return undefined;
  const avatarUrl = text(each?.["avatarUrl"]);
  return avatarUrl === undefined ? { login } : { login, avatarUrl };
};

export const label = (value: unknown): GitHubLabel | undefined => {
  const each = json(value);
  const name = text(each?.["name"]);
  if (name === undefined || name === "") return undefined;
  const description = text(each?.["description"]);
  return {
    name,
    color: text(each?.["color"]) ?? "ededed",
    ...(description === undefined || description === "" ? {} : { description }),
  };
};

const REACTION_KINDS: Readonly<Record<string, ReactionKind>> = {
  THUMBS_UP: "thumbsUp",
  THUMBS_DOWN: "thumbsDown",
  LAUGH: "laugh",
  HOORAY: "hooray",
  CONFUSED: "confused",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
};

/** The kinds of reaction anyone left, from `reactionGroups`. */
export const reactions = (groups: unknown): ReadonlyArray<GitHubReaction> =>
  (Array.isArray(groups) ? groups : []).flatMap((group): ReadonlyArray<GitHubReaction> => {
    const each = json(group);
    const kind = REACTION_KINDS[text(each?.["content"]) ?? ""];
    const count = whole(json(each?.["reactors"])?.["totalCount"]) ?? 0;
    return kind === undefined || count === 0 ? [] : [{ kind, count, mine: flag(each?.["viewerHasReacted"]) }];
  });

const ASSOCIATIONS: Readonly<Record<string, GitHubAssociation>> = {
  OWNER: "owner",
  MEMBER: "member",
  COLLABORATOR: "collaborator",
  CONTRIBUTOR: "contributor",
  FIRST_TIME_CONTRIBUTOR: "firstTimer",
  FIRST_TIMER: "firstTimer",
};

/** How the author is tied to the repository; nothing for outsiders, who need no badge. */
export const association = (value: unknown): GitHubAssociation | undefined => ASSOCIATIONS[text(value) ?? ""];

const STATE_REASONS: Readonly<Record<string, "completed" | "notPlanned" | "duplicate">> = {
  COMPLETED: "completed",
  NOT_PLANNED: "notPlanned",
  DUPLICATE: "duplicate",
};

export const stateReason = (value: unknown) => STATE_REASONS[text(value) ?? ""];

/** `owner/name`, only when it differs from the conversation's own repository. */
export const elsewhere = (repository: unknown, own: string | undefined): string | undefined => {
  const name = text(json(repository)?.["nameWithOwner"]);
  return name === undefined || name.toLowerCase() === own?.toLowerCase() ? undefined : name;
};

export const reference = (value: unknown, own: string | undefined): GitHubReference | undefined => {
  const each = json(value);
  const number = whole(each?.["number"]);
  const url = text(each?.["url"]);
  if (each === undefined || number === undefined || url === undefined) return undefined;
  const repository = elsewhere(each["repository"], own);
  return {
    kind: each["__typename"] === "PullRequest" ? "pullRequest" : "issue",
    number,
    title: text(each["title"]) ?? "",
    url,
    ...(repository === undefined ? {} : { repository }),
  };
};

/** A comment's fields as a conversation shows them, from GraphQL's `IssueComment`-like node. */
export const commentOf = (node: Json, at: number) => {
  const id = text(node["id"]);
  if (id === undefined) return undefined;
  const author = user(node["author"]);
  const edited = time(node["lastEditedAt"]);
  const standing = association(node["authorAssociation"]);
  const url = text(node["url"]);
  return {
    id,
    ...(author === undefined ? {} : { author }),
    body: text(node["body"]) ?? "",
    at,
    ...(edited === undefined ? {} : { edited }),
    ...(standing === undefined ? {} : { association: standing }),
    reactions: reactions(node["reactionGroups"]),
    ...(url === undefined ? {} : { url }),
    ...(node["isMinimized"] === true
      ? { hidden: (text(node["minimizedReason"]) ?? "hidden").toLowerCase().replaceAll("_", " ") }
      : {}),
  };
};

const REVIEW_STATES: Readonly<Record<string, ReviewState>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changesRequested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending",
};

export const reviewState = (value: unknown): ReviewState => REVIEW_STATES[text(value) ?? ""] ?? "commented";

/** A commit of `PullRequestCommit`'s `commit`. */
export const commitOf = (value: unknown): ConversationCommit | undefined => {
  const commit = json(value);
  const oid = text(commit?.["oid"]);
  const at = time(commit?.["committedDate"]);
  const url = text(commit?.["url"]);
  if (oid === undefined || at === undefined || url === undefined) return undefined;
  const author = json(commit?.["author"]);
  const account = user(author?.["user"]);
  const authorName = text(author?.["name"]);
  return {
    oid,
    headline: text(commit?.["messageHeadline"]) ?? "",
    ...(account === undefined ? {} : { author: account }),
    ...(authorName === undefined || authorName === "" ? {} : { authorName }),
    at,
    url,
  };
};

const reviewerName = (value: unknown): string | undefined => {
  const each = json(value);
  return text(each?.["login"]) ?? text(each?.["name"]);
};

// ---------------------------------------------------------------------------------------------
// Timelines

/** An entry of a conversation as GitHub sent it; none for one the conversation doesn't show. */
export const conversationItem = (node: Json, own: string | undefined): ConversationItem | undefined => {
  if (node["__typename"] === "PullRequestCommit") {
    const commit = commitOf(node["commit"]);
    if (commit === undefined) return undefined;
    const actor = commit.author;
    return { _tag: "Commits", at: commit.at, ...(actor === undefined ? {} : { actor }), commits: [commit] };
  }
  const at = time(node["createdAt"]) ?? time(node["submittedAt"]);
  if (at === undefined) return undefined;
  const actor = user(node["actor"]);
  const by = actor === undefined ? {} : { actor };
  switch (node["__typename"]) {
    case "IssueComment": {
      const comment = commentOf(node, at);
      return comment === undefined ? undefined : { _tag: "Comment", ...comment };
    }
    case "PullRequestReview": {
      // A review's time is when it was submitted; one still being written isn't anyone else's to see.
      const submitted = time(node["submittedAt"]);
      const comment = submitted === undefined ? undefined : commentOf(node, submitted);
      return comment === undefined
        ? undefined
        : { _tag: "Review", ...comment, state: reviewState(node["state"]) };
    }
    case "LabeledEvent":
    case "UnlabeledEvent": {
      const each = label(node["label"]);
      if (each === undefined) return undefined;
      return {
        _tag: "Labels",
        at,
        ...by,
        added: node["__typename"] === "LabeledEvent" ? [each] : [],
        removed: node["__typename"] === "UnlabeledEvent" ? [each] : [],
      };
    }
    case "AssignedEvent":
    case "UnassignedEvent": {
      const login = text(json(node["assignee"])?.["login"]);
      if (login === undefined) return undefined;
      return {
        _tag: "Assignees",
        at,
        ...by,
        added: node["__typename"] === "AssignedEvent" ? [login] : [],
        removed: node["__typename"] === "UnassignedEvent" ? [login] : [],
      };
    }
    case "ClosedEvent": {
      const reason = stateReason(node["stateReason"]);
      const closer = json(node["closer"]);
      const url = text(closer?.["url"]);
      const name =
        closer?.["__typename"] === "PullRequest"
          ? `#${whole(closer["number"]) ?? ""}`
          : text(closer?.["abbreviatedOid"]);
      return {
        _tag: "Closed",
        at,
        ...by,
        ...(reason === undefined ? {} : { reason }),
        ...(url === undefined || name === undefined ? {} : { by: { label: name, url } }),
      };
    }
    case "ReopenedEvent":
      return { _tag: "Reopened", at, ...by };
    case "RenamedTitleEvent":
      return {
        _tag: "Renamed",
        at,
        ...by,
        from: text(node["previousTitle"]) ?? "",
        to: text(node["currentTitle"]) ?? "",
      };
    case "MilestonedEvent":
    case "DemilestonedEvent":
      return {
        _tag: "Milestone",
        at,
        ...by,
        title: text(node["milestoneTitle"]) ?? "",
        removed: node["__typename"] === "DemilestonedEvent",
      };
    case "CrossReferencedEvent": {
      const source = reference(node["source"], own);
      if (source === undefined) return undefined;
      return { _tag: "Referenced", at, ...by, by: source, closes: flag(node["willCloseTarget"]) };
    }
    case "ReferencedEvent": {
      const commit = json(node["commit"]);
      const oid = text(commit?.["abbreviatedOid"]);
      const url = text(commit?.["url"]);
      if (oid === undefined || url === undefined) return undefined;
      return { _tag: "Committed", at, ...by, oid, headline: text(commit?.["messageHeadline"]) ?? "", url };
    }
    case "LockedEvent":
    case "UnlockedEvent": {
      const reason = text(node["lockReason"]);
      return {
        _tag: "Locked",
        at,
        ...by,
        locked: node["__typename"] === "LockedEvent",
        ...(reason === undefined ? {} : { reason: reason.toLowerCase().replaceAll("_", " ") }),
      };
    }
    case "ConnectedEvent":
    case "DisconnectedEvent": {
      const subject = reference(node["subject"], own);
      if (subject === undefined) return undefined;
      return { _tag: "Linked", at, ...by, subject, unlinked: node["__typename"] === "DisconnectedEvent" };
    }
    case "MarkedAsDuplicateEvent": {
      const of = reference(node["canonical"], own);
      return of === undefined ? undefined : { _tag: "Duplicate", at, ...by, of };
    }
    case "TransferredEvent": {
      const from = text(json(node["fromRepository"])?.["nameWithOwner"]);
      return from === undefined ? undefined : { _tag: "Transferred", at, ...by, from };
    }
    case "ReviewRequestedEvent":
    case "ReviewRequestRemovedEvent": {
      const reviewer = reviewerName(node["requestedReviewer"]);
      if (reviewer === undefined) return undefined;
      return {
        _tag: "ReviewRequested",
        at,
        ...by,
        reviewer,
        removed: node["__typename"] === "ReviewRequestRemovedEvent",
      };
    }
    case "MergedEvent": {
      const commit = json(node["commit"]);
      return {
        _tag: "Merged",
        at,
        ...by,
        oid: text(commit?.["oid"]) ?? "",
        base: text(node["mergeRefName"]) ?? "",
        url: text(commit?.["url"]) ?? "",
      };
    }
    case "ReadyForReviewEvent":
    case "ConvertToDraftEvent":
      return { _tag: "Draft", at, ...by, draft: node["__typename"] === "ConvertToDraftEvent" };
    case "HeadRefForcePushedEvent": {
      const before = text(json(node["beforeCommit"])?.["abbreviatedOid"]);
      const after = text(json(node["afterCommit"])?.["abbreviatedOid"]);
      return {
        _tag: "ForcePushed",
        at,
        ...by,
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      };
    }
    case "HeadRefDeletedEvent":
    case "HeadRefRestoredEvent":
      return { _tag: "Branch", at, ...by, deleted: node["__typename"] === "HeadRefDeletedEvent" };
    case "BaseRefChangedEvent":
      return {
        _tag: "BaseChanged",
        at,
        ...by,
        from: text(node["previousRefName"]) ?? "",
        to: text(node["currentRefName"]) ?? "",
      };
    default:
      return undefined;
  }
};

/** Events of one kind by one person this close together read as one entry. */
const GROUP_WITHIN = 60_000;

/** Commits pushed this close together, by one person, read as one push. */
const PUSH_WITHIN = 10 * 60_000;

/** Who did or wrote an entry. */
const whoOf = (item: ConversationItem) =>
  (item._tag === "Comment" || item._tag === "Review" ? item.author : item.actor)?.login;

/**
 * The conversation in `nodes`, in order. Labels added and removed, or people assigned and unassigned,
 * by one person within a minute make one entry, as GitHub shows them; so do commits one after
 * another by one person.
 */
export const parseConversation = (
  nodes: ReadonlyArray<unknown>,
  own?: string,
): ReadonlyArray<ConversationItem> => {
  const items: Array<ConversationItem> = [];
  let lastAt = 0;
  for (const node of nodes) {
    const each = json(node);
    const item = each === undefined ? undefined : conversationItem(each, own);
    if (item === undefined) continue;
    const previous = items.at(-1);
    const sameActor = previous !== undefined && whoOf(previous) === whoOf(item);
    if (
      previous?._tag === "Commits" &&
      item._tag === "Commits" &&
      sameActor &&
      item.at - lastAt <= PUSH_WITHIN
    ) {
      items[items.length - 1] = { ...previous, commits: [...previous.commits, ...item.commits] };
      lastAt = item.at;
      continue;
    }
    if (previous !== undefined && sameActor && item.at - lastAt <= GROUP_WITHIN) {
      if (previous._tag === "Labels" && item._tag === "Labels") {
        items[items.length - 1] = {
          ...previous,
          added: [...previous.added, ...item.added],
          removed: [...previous.removed, ...item.removed],
        };
        lastAt = item.at;
        continue;
      }
      if (previous._tag === "Assignees" && item._tag === "Assignees") {
        items[items.length - 1] = {
          ...previous,
          added: [...previous.added, ...item.added],
          removed: [...previous.removed, ...item.removed],
        };
        lastAt = item.at;
        continue;
      }
    }
    items.push(item);
    lastAt = item.at;
  }
  // A label added and taken off again in the same minute nets out to nothing.
  return items.flatMap((item): ReadonlyArray<ConversationItem> => {
    if (item._tag !== "Labels") return [item];
    const kept = (from: ReadonlyArray<GitHubLabel>, other: ReadonlyArray<GitHubLabel>) =>
      from.filter((each) => !other.some((that) => that.name === each.name));
    const added = kept(item.added, item.removed);
    const removed = kept(item.removed, item.added);
    return added.length === 0 && removed.length === 0 ? [] : [{ ...item, added, removed }];
  });
};
