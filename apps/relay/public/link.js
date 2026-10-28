// The page a machine opens in the user's browser to join their Cerium account, and the web client
// opens in its own tab. It signs in with Clerk, shows which device is asking, and confirms it with
// the user's session token. Confirming hands the page a one-time code, which it takes where the
// relay says: to Cerium on this computer, listening on its loopback address, which sends the page
// back here; or to the web client on this origin. The device joins once it claims the link with that
// code, so a link someone else started and sent the user can't join their account. The link's id
// rides in the URL's fragment, so it never reaches a server log; it's kept for the tab in case a
// sign-in redirect drops it.

const CLERK_JS_VERSION = "6.37.0";
const CLERK_UI_VERSION = "1.38.1";
const LINK_ID = /^[A-Za-z0-9_-]{32,}$/;
const STORED_LINK = "cerium-link";

const panel = document.getElementById("panel");

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** How long the page waits for the machine to claim a link it confirmed, and how often it asks. */
const FINISH_WITHIN_MS = 15_000;
const FINISH_POLL_MS = 1_000;

// Lucide's monitor, smartphone, globe, check, link-2-off and loader-circle.
const icons = {
  desktop: svg('<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>'),
  phone: svg('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>'),
  browser: svg(
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  ),
  success: svg('<path d="M20 6 9 17l-5-5"/>'),
  muted: svg(
    '<path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><path d="M8 12h4"/><path d="m2 2 20 20"/>',
  ),
  waiting: svg('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'),
};

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

const PLATFORMS = { win32: "Windows", darwin: "macOS", linux: "Linux", ios: "iOS", android: "Android" };
const CHANNELS = { nightly: "Nightly", dev: "Development build" };

/** "Windows · Nightly · 0.4.0", or "iOS · Web app": enough to recognise the device. */
const describe = (device) =>
  [
    PLATFORMS[device.platform] ?? device.platform,
    device.kind === "browser" ? "Web app" : undefined,
    CHANNELS[device.channel],
    device.version,
  ]
    .filter((part) => part !== undefined && part !== "dev")
    .join(" · ");

const isBrowser = (device) => device.kind === "browser";

/** What the page calls the device: a computer joining, or this browser or phone. */
const noun = (device) => (isBrowser(device) ? "device" : "machine");

const iconFor = (device) =>
  !isBrowser(device)
    ? icons.desktop
    : device.platform === "ios" || device.platform === "android"
      ? icons.phone
      : icons.browser;

const machineCard = (device) => `
  <div class="machine">
    ${iconFor(device)}
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

/**
 * Clerk's components in Cerium's tokens, flattened into this page's panel. The accent goes by the
 * aliases in link.css, since Clerk's buttons define an `--accent` of their own.
 */
const appearance = {
  variables: {
    colorPrimary: "var(--cerium-accent)",
    colorPrimaryForeground: "var(--cerium-accent-fg)",
    colorBackground: "var(--surface-raised)",
    colorForeground: "var(--fg-primary)",
    colorMutedForeground: "var(--fg-tertiary)",
    colorInput: "var(--surface-sunken)",
    colorInputForeground: "var(--fg-primary)",
    colorNeutral: "var(--fg-primary)",
    colorBorder: "var(--line-strong)",
    colorDanger: "var(--status-error)",
    fontFamily: "var(--font-sans)",
    borderRadius: "12px",
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
    // Clerk offsets the card a pixel each way for a border it no longer has here.
    card: {
      padding: "0",
      margin: "0",
      width: "100%",
      boxShadow: "none",
      border: "none",
      background: "transparent",
    },
    header: { display: "none" },
    footer: { background: "transparent" },
    // The website's pill.
    formButtonPrimary: {
      height: "44px",
      borderRadius: "999px",
      backgroundColor: "var(--cerium-accent)",
      backgroundImage: "none",
      color: "var(--cerium-accent-fg)",
      boxShadow: "none",
      border: "none",
      "&:hover, &:focus": { backgroundColor: "var(--cerium-accent-strong)" },
    },
    socialButtonsIconButton: {
      backgroundColor: "var(--surface-sunken)",
      border: "1px solid var(--line-subtle)",
      boxShadow: "none",
      "&:hover": { backgroundColor: "var(--surface-hover)", borderColor: "var(--line-strong)" },
    },
    socialButtonsBlockButton: {
      backgroundColor: "var(--surface-sunken)",
      border: "1px solid var(--line-subtle)",
      boxShadow: "none",
      "&:hover": { backgroundColor: "var(--surface-hover)", borderColor: "var(--line-strong)" },
    },
    formFieldInput: { border: "1px solid var(--line-subtle)", boxShadow: "none" },
    dividerLine: { backgroundColor: "var(--line-subtle)" },
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
  const showConnected = () =>
    showOutcome(
      "success",
      "Connected",
      `${device.name} is now part of your account. You can close this tab and go back to Cerium.`,
    );
  let status = link.body.status;
  let error;
  // Cerium on this computer took the code and sent the page back: it joins in a moment.
  if (status === "approved" && !isBrowser(device)) {
    showOutcome("waiting", "Finishing in Cerium", `${device.name} is joining your account…`);
    const until = Date.now() + FINISH_WITHIN_MS;
    while (status === "approved" && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, FINISH_POLL_MS));
      const again = await request(`/api/links/${id}`).catch(() => undefined);
      if (again?.status === 404) return showExpired();
      if (again?.ok) status = again.body.status;
    }
    if (status === "approved")
      error =
        "Cerium on this computer didn't take this sign-in. If you started it here, make sure Cerium is open and connect again.";
  }
  if (status === "confirmed") {
    if (isBrowser(device)) return location.replace("/app/");
    return showConnected();
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
        <h1>Connect a ${noun(device)}</h1>
        <p class="lead">Sign in to your Cerium account to connect this ${noun(device)} to it.</p>
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
      <p class="lead">${
        isBrowser(device)
          ? "It joins your Cerium account, so it can see and drive your computers."
          : "It joins your Cerium account, so your other devices can see and drive it."
      }</p>
      ${machineCard(device)}
      <div class="account">
        <span>Signed in as <strong>${escapeHtml(who)}</strong></span>
        <button type="button" class="link-button" id="switch">Use another account</button>
      </div>
      <p class="caution">Only continue if you just started signing in ${
        isBrowser(device) ? "on this device" : "from this machine"
      } yourself.</p>
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
        error = result.body.message ?? `The relay couldn't connect this ${noun(device)}. Try again.`;
        return;
      }
      const next = result.body.next;
      if (typeof next !== "string") {
        error = `The relay couldn't connect this ${noun(device)}. Try again.`;
        return;
      }
      finished = true;
      try {
        sessionStorage.removeItem(STORED_LINK);
      } catch {
        // Storage is off; nothing was kept.
      }
      // A browser signs in from its own tab: back to the app, which finishes signing in with the
      // code. A machine's Cerium takes it on this computer and sends the page back here.
      if (isBrowser(device)) {
        location.replace(next);
        return;
      }
      showOutcome("waiting", "Finishing in Cerium", `${device.name} is joining your account…`);
      location.assign(next);
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

// Back from a page the code was taken to, the browser may show this one as it was left: load it
// again, to say how the sign-in went.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

main().catch(() =>
  showOutcome(
    "muted",
    "Sign-in isn't available",
    "Something went wrong loading this page. Reload to try again.",
  ),
);
