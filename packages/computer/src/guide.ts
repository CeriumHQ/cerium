// What `computer_guide` answers: agent-desktop's own guide, compiled into the build Cerium runs so it
// always matches it, under Cerium's notes on how its commands reach agent-desktop through the tools.

/** The references agent-desktop's guide points to, and the guide for this operating system. */
export const GUIDE_TOPICS = [
  "platform",
  "commands-observation",
  "commands-interaction",
  "commands-system",
  "workflows",
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

const NOTES = `# Computer use in Cerium

You operate the user's real desktop through agent-desktop. Its guide follows, written for its command
line; in Cerium you never run that command line. Each command is a step \`{ "command", "args" }\`:

- \`args\` are the command's flags with hyphens as underscores and without the dashes
  (\`--window-id w-1\` → \`"window_id": "w-1"\`, \`-i\` → \`"interactive_only": true\`), and its positional
  argument by name: \`ref_id\` (click, type …), \`text\` (type), \`combo\` (press), \`app\` (launch).
  \`agent-desktop snapshot --app Notepad -i --compact\` is
  \`{ "command": "snapshot", "args": { "app": "Notepad", "interactive_only": true, "compact": true } }\`.
- computer_read runs one step that only looks (snapshot, find, get, is, screenshot, list-apps,
  list-windows, list-displays, list-surfaces, list-notifications, clipboard-get, wait, status). A
  screenshot comes back as an image; it takes \`app\`, \`window_id\` or \`screen\`.
- computer_act runs up to 30 steps that change something, in order, stopping at the first that fails.
  Its \`description\` is what the user sees and approves, so say plainly what the steps do.
- \`physical: true\` on computer_act is agent-desktop's \`--headed\`: the real pointer and keyboard,
  which the user may be using at the same moment. Use it only for steps that need it (drag, hover,
  typing where the platform requires it), never to retry a step that failed headless. The user allows
  it in Settings → Computer use; without that, say what you need and ask them.
- Cerium keeps your session and your cursor: leave out \`session\`, \`agent_id\`, \`headed\`,
  \`screenshot\`, \`trace\` and \`force\`, and don't run batch, session, cursor-overlay, trace or skills.
- Prefer refs from a snapshot to points from a screenshot. Never type passwords or payment details,
  accept terms, or send messages for the user unless they asked for that exact thing.

`;

/** `content`, one of agent-desktop's guides, as computer_guide gives it for `topic`. */
export const guideFor = (topic: GuideTopic | undefined, content: string): string =>
  topic === undefined
    ? `${NOTES}${content}\n\nFor a reference, call computer_guide with \`topic\`: ${GUIDE_TOPICS.join(", ")}. Where the guide says to run \`agent-desktop skills get …\`, use that topic instead.`
    : `${content}\n\n(Through Cerium, each command here is a step for computer_read or computer_act.)`;
