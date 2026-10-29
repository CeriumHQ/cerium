// The page an MCP client (Claude, ChatGPT, Grok, an editor; an "assistant" in the code) sends the
// user to when they connect it to Cerium's remote MCP server: `/oauth/authorize`, which the relay
// answers with this page. It signs in with Clerk, shows which app asks and where it sends the user
// back, and allows it with the user's session token. Allowing hands the page a code to take back to
// the app, which redeems it for its tokens; cancelling takes the app the refusal instead.

import { escapeHtml, loadClerk, request } from "/clerk.js";

const panel = document.getElementById("panel");

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

// Lucide's bot, link-2-off and loader-circle.
const icons = {
  assistant: svg(
    '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  ),
  muted: svg(
    '<path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><path d="M8 12h4"/><path d="m2 2 20 20"/>',
  ),
  waiting: svg('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'),
};

const showOutcome = (tone, title, text) => {
  panel.innerHTML = `
    <div class="outcome-icon ${tone}">${icons[tone]}</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="lead">${escapeHtml(text)}</p>`;
};

const unavailable = () =>
  showOutcome(
    "muted",
    "Connecting isn't available",
    "Cerium's relay couldn't be reached. Try again in a moment.",
  );

const assistantCard = (assistant) => `
  <div class="machine">
    ${icons.assistant}
    <div>
      <div class="machine-name">${escapeHtml(assistant.name)}</div>
      <div class="machine-meta">Returns to ${escapeHtml(assistant.site)}</div>
    </div>
  </div>`;

const main = async () => {
  // The assistant's request, which the relay reads again when the user allows it.
  const query = location.search.slice(1);
  if (query === "")
    return showOutcome(
      "muted",
      "Nothing to allow",
      "Add Cerium as a remote MCP server in your app, and connect from there.",
    );

  const [asked, config] = await Promise.all([request(`/api/oauth/client?${query}`), request("/api/config")]);
  if (asked.status === 400)
    return showOutcome(
      "muted",
      "This app can't connect",
      asked.body.message ?? "Connect Cerium again from the app.",
    );
  if (!asked.ok || !config.ok || typeof config.body.publishableKey !== "string") return unavailable();
  if (typeof asked.body.next === "string") return location.replace(asked.body.next);
  const assistant = asked.body;

  const clerk = await loadClerk(config.body.publishableKey);

  let signInMount;
  let busy = false;
  let finished = false;
  let error;

  const unmountSignIn = () => {
    if (signInMount === undefined) return;
    clerk.unmountSignIn(signInMount);
    signInMount = undefined;
  };

  const render = () => {
    if (finished) return;
    const user = clerk.user;
    if (!user) {
      if (signInMount?.isConnected) return;
      panel.innerHTML = `
        <h1>Connect ${escapeHtml(assistant.name)}</h1>
        <p class="lead">Sign in to your Cerium account to let this app manage your threads.</p>
        ${assistantCard(assistant)}
        <div id="sign-in"></div>`;
      signInMount = document.getElementById("sign-in");
      clerk.mountSignIn(signInMount, {
        routing: "virtual",
        withSignUp: true,
        forceRedirectUrl: location.href,
        signUpForceRedirectUrl: location.href,
      });
      return;
    }

    unmountSignIn();
    const who = user.primaryEmailAddress?.emailAddress ?? user.fullName ?? user.username ?? "your account";
    panel.innerHTML = `
      <h1>Allow ${escapeHtml(assistant.name)}?</h1>
      <p class="lead">It can start threads on your computers that allow remote MCP, send messages to
        their agents, and read your threads' titles, status and latest messages.</p>
      ${assistantCard(assistant)}
      <div class="account">
        <span>Signed in as <strong>${escapeHtml(who)}</strong></span>
        <button type="button" class="link-button" id="switch">Use another account</button>
      </div>
      <p class="caution">Only continue if you just connected Cerium from ${escapeHtml(assistant.site)} yourself.
        You can disconnect it any time in Cerium: Settings → Remote MCP.</p>
      <button type="button" class="button" id="allow" ${busy ? "disabled" : ""}>
        ${busy ? "Allowing…" : "Allow"}
      </button>
      <button type="button" class="link-button cancel" id="cancel">Cancel</button>
      ${error === undefined ? "" : `<p class="error" role="alert">${escapeHtml(error)}</p>`}`;

    document.getElementById("switch").addEventListener("click", () => void clerk.signOut());
    document.getElementById("allow").addEventListener("click", () => void allow());
    document.getElementById("cancel").addEventListener("click", () => {
      finished = true;
      location.assign(assistant.deny);
    });
  };

  const allow = async () => {
    busy = true;
    error = undefined;
    render();
    try {
      const token = await clerk.session?.getToken();
      const result = await request("/api/oauth/approve", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ request: query }),
      });
      if (!result.ok || typeof result.body.next !== "string") {
        error = result.body.message ?? "The relay couldn't allow this app. Try again.";
        return;
      }
      finished = true;
      showOutcome("waiting", `Returning to ${assistant.name}`, "Cerium is connected. Finish in the app.");
      location.assign(result.body.next);
    } catch {
      error = "Couldn't reach Cerium's relay. Check your connection and try again.";
    } finally {
      busy = false;
      render();
    }
  };

  clerk.addListener(() => render());
  render();
};

main().catch(() =>
  showOutcome(
    "muted",
    "Connecting isn't available",
    "Something went wrong loading this page. Reload to try again.",
  ),
);
