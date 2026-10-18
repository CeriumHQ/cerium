// The page a machine opens in the user's browser to join their Cerium account
// (docs/architecture.md §14.2). It signs in with Clerk, shows which machine is asking, and confirms
// it with the user's session token. The link's id rides in the URL's fragment, so it never reaches
// a server log; it's kept for the tab in case a sign-in redirect drops it.

const CLERK_JS_VERSION = "6.37.0";
const CLERK_UI_VERSION = "1.38.1";
const LINK_ID = /^[A-Za-z0-9_-]{32,}$/;
const STORED_LINK = "cerium-link";

const panel = document.getElementById("panel");

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

// Lucide's monitor, check, clock and link-2-off.
const icons = {
  desktop: svg('<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>'),
  success: svg('<path d="M20 6 9 17l-5-5"/>'),
  attention: svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  muted: svg(
    '<path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><path d="M8 12h4"/><path d="m2 2 20 20"/>',
  ),
};

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

const PLATFORMS = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const CHANNELS = { nightly: "Nightly", dev: "Development build" };

/** "Windows · Nightly · 0.4.0": enough to recognise the machine. */
const describe = (device) =>
  [PLATFORMS[device.platform] ?? device.platform, CHANNELS[device.channel], device.version]
    .filter((part) => part !== undefined && part !== "dev")
    .join(" · ");

const machineCard = (device) => `
  <div class="machine">
    ${icons.desktop}
    <div>
      <div class="machine-name">${escapeHtml(device.name)}</div>
      <div class="machine-meta">${escapeHtml(describe(device))}</div>
    </div>
  </div>`;

const showOutcome = (tone, title, text) => {
  panel.innerHTML = `
    <div class="outcome-icon ${tone}">${icons[tone]}</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="lead">${escapeHtml(text)}</p>`;
};

const showExpired = () =>
  showOutcome("muted", "This sign-in link has expired", "Start again from Settings → Account in Cerium.");

const linkId = () => {
  const fromUrl = location.hash.slice(1);
  try {
    if (LINK_ID.test(fromUrl)) {
      sessionStorage.setItem(STORED_LINK, fromUrl);
      return fromUrl;
    }
    const stored = sessionStorage.getItem(STORED_LINK);
    return stored !== null && LINK_ID.test(stored) ? stored : undefined;
  } catch {
    return LINK_ID.test(fromUrl) ? fromUrl : undefined;
  }
};

/** A JSON request to the relay; `body` is its answer, or its refusal's `{ message }`. */
const request = async (path, init) => {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
};

const loadScript = (src, attributes = {}) =>
  new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.crossOrigin = "anonymous";
    script.async = true;
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    script.addEventListener("load", resolve);
    script.addEventListener("error", () => reject(new Error(`Couldn't load ${src}`)));
    document.head.append(script);
  });

/** Clerk's Frontend API host, which the publishable key encodes (`pk_test_<base64 of "host$">`). */
const frontendApi = (publishableKey) => atob(publishableKey.split("_")[2] ?? "").replace(/\$$/, "");

/** Clerk's components in Cerium's tokens, flattened into this page's panel. */
const appearance = {
  variables: {
    colorPrimary: "var(--accent)",
    colorPrimaryForeground: "var(--accent-fg)",
    colorBackground: "var(--surface-raised)",
    colorForeground: "var(--fg-primary)",
    colorMutedForeground: "var(--fg-tertiary)",
    colorInput: "var(--surface-sunken)",
    colorInputForeground: "var(--fg-primary)",
    colorNeutral: "var(--fg-primary)",
    colorBorder: "var(--line-strong)",
    colorDanger: "var(--status-error)",
    fontFamily: "var(--font-sans)",
    borderRadius: "9px",
  },
  elements: {
    rootBox: { width: "100%" },
    cardBox: {
      width: "100%",
      boxShadow: "none",
      border: "none",
      borderRadius: "0",
      background: "transparent",
    },
    card: { padding: "0", boxShadow: "none", border: "none", background: "transparent" },
    header: { display: "none" },
    footer: { background: "transparent" },
  },
};

const main = async () => {
  const id = linkId();
  if (id === undefined) return showExpired();

  const [link, config] = await Promise.all([request(`/api/links/${id}`), request("/api/config")]);
  if (link.status === 404) return showExpired();
  if (!link.ok || !config.ok || typeof config.body.publishableKey !== "string") {
    return showOutcome(
      "muted",
      "Sign-in isn't available",
      "Cerium's relay couldn't be reached. Try again in a moment.",
    );
  }
  const device = link.body.device;
  if (link.body.status === "confirmed") {
    return showOutcome(
      "success",
      "Already connected",
      `${device.name} is part of your account. You can close this tab.`,
    );
  }

  const key = config.body.publishableKey;
  const host = frontendApi(key);
  await loadScript(`https://${host}/npm/@clerk/ui@${CLERK_UI_VERSION}/dist/ui.browser.js`);
  await loadScript(`https://${host}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`, {
    "data-clerk-publishable-key": key,
  });
  const clerk = window.Clerk;
  await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor }, appearance });

  let signInMount;
  let busy = false;
  let error;
  let finished = false;

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
        <h1>Connect a machine</h1>
        <p class="lead">Sign in to your Cerium account to connect this machine to it.</p>
        ${machineCard(device)}
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
      <h1>Connect ${escapeHtml(device.name)}?</h1>
      <p class="lead">It joins your Cerium account, so your other devices can see and drive it.</p>
      ${machineCard(device)}
      <div class="account">
        <span>Signed in as <strong>${escapeHtml(who)}</strong></span>
        <button type="button" class="link-button" id="switch">Use another account</button>
      </div>
      <p class="caution">Only continue if you just started signing in from this machine yourself.</p>
      <button type="button" class="button" id="connect" ${busy ? "disabled" : ""}>
        ${busy ? "Connecting…" : "Connect"}
      </button>
      ${error === undefined ? "" : `<p class="error" role="alert">${escapeHtml(error)}</p>`}`;

    document.getElementById("switch").addEventListener("click", () => void clerk.signOut());
    document.getElementById("connect").addEventListener("click", () => void connect());
  };

  const connect = async () => {
    busy = true;
    error = undefined;
    render();
    try {
      const token = await clerk.session?.getToken();
      const user = clerk.user;
      const profile = {
        name: user?.fullName ?? user?.username ?? undefined,
        email: user?.primaryEmailAddress?.emailAddress ?? undefined,
        imageUrl: user?.imageUrl ?? undefined,
      };
      const result = await request(`/api/links/${id}/confirm`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile }),
      });
      if (result.status === 410) {
        finished = true;
        return showExpired();
      }
      if (!result.ok) {
        error = result.body.message ?? "The relay couldn't connect this machine. Try again.";
        return;
      }
      finished = true;
      try {
        sessionStorage.removeItem(STORED_LINK);
      } catch {
        // Storage is off; nothing was kept.
      }
      if (result.body.approved) {
        showOutcome(
          "success",
          "Connected",
          `${device.name} is now part of your account. You can close this tab and go back to Cerium.`,
        );
      } else {
        showOutcome(
          "attention",
          "Waiting for approval",
          `${device.name} joined your account. Approve it in Cerium on a device that's already connected; until then it sees nothing.`,
        );
      }
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
    "Sign-in isn't available",
    "Something went wrong loading this page. Reload to try again.",
  ),
);
