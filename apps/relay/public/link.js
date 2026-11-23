// The page a machine opens in the user's browser to join their Cerium account, and the web client
// opens in its own tab. It signs in with Clerk, shows which device is asking, and confirms it with
// the user's session token. Confirming hands the page a one-time code, which it takes where the
// relay says: to Cerium on this computer, listening on its loopback address, which sends the page
// back here; or to the web client on this origin. The device joins once it claims the link with that
// code. A CLI user can instead copy the code into their terminal. The link's id
// rides in the URL's fragment, so it never reaches a server log; it's kept for the tab in case a
// sign-in redirect drops it.

import { escapeHtml, loadClerk, request } from "/clerk.js";

const LINK_ID = /^[A-Za-z0-9_-]{32,}$/;
const STORED_LINK = "cerium-link";

const panel = document.getElementById("panel");

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** How long the page waits for the machine to claim a link it confirmed, and how often it asks. */
const FINISH_WITHIN_MS = 15_000;
const FINISH_POLL_MS = 1_000;

// Lucide's monitor, smartphone and globe.
const icons = {
  desktop: svg('<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>'),
  phone: svg('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>'),
  browser: svg(
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  ),
};

const PLATFORMS = { win32: "Windows", darwin: "macOS", linux: "Linux", ios: "iOS", android: "Android" };
const CHANNELS = { nightly: "Nightly", dev: "Development build" };

/** "Windows · Nightly · 0.4.0", or "iOS · Web app": enough to recognise the device. */
const describe = (device) =>
  [
    PLATFORMS[device.platform] ?? device.platform,
    device.kind === "browser" ? "Web app" : undefined,
    device.headless ? "Headless CLI" : undefined,
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

const showOutcome = (title, text) => {
  panel.innerHTML = `
    <h1>${escapeHtml(title)}</h1>
    <p class="lead">${escapeHtml(text)}</p>`;
};

const showExpired = () =>
  showOutcome("This sign-in link has expired", "Start sign-in again on the device you want to connect.");

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

const main = async () => {
  const id = linkId();
  if (id === undefined) return showExpired();

  const [link, config] = await Promise.all([request(`/api/links/${id}`), request("/api/config")]);
  if (link.status === 404) return showExpired();
  if (!link.ok || !config.ok || typeof config.body.publishableKey !== "string") {
    return showOutcome(
      "Sign-in isn't available",
      "Cerium's relay couldn't be reached. Try again in a moment.",
    );
  }
  const device = link.body.device;
  const showConnected = () =>
    showOutcome(
      "Connected",
      `${device.name} is now part of your account. You can close this tab and go back to Cerium.`,
    );
  const waitForClaim = async (until) => {
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, FINISH_POLL_MS));
      const again = await request(`/api/links/${id}`).catch(() => undefined);
      if (again?.status === 404) return "expired";
      if (again?.ok && again.body.status === "confirmed") return "connected";
    }
    return "timeout";
  };

  const showCode = async (code) => {
    panel.innerHTML = `
      <h1>Finish in your terminal</h1>
      <p class="lead">Paste this code into the terminal where you started signing in on <strong>${escapeHtml(device.name)}</strong>.</p>
      <code class="handoff-code" tabindex="0" id="code">${escapeHtml(code)}</code>
      <button type="button" class="button" id="copy">Copy code</button>
      <p class="copy-status" role="status" id="copy-status"></p>`;
    const status = document.getElementById("copy-status");
    const displayedCode = document.getElementById("code");
    document.getElementById("copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code);
        status.textContent = "Code copied.";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(displayedCode);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        status.textContent = "Copy the selected code.";
      }
    });
    const outcome = await waitForClaim(link.body.expiresAt);
    return outcome === "connected" ? showConnected() : showExpired();
  };

  let error;
  if (link.body.status === "confirmed") {
    if (isBrowser(device)) return location.replace("/app/");
    return showConnected();
  }
  // A loopback listener sent the page back. A reloaded manual link can issue a fresh code.
  if (link.body.status === "approved" && !isBrowser(device) && link.body.handoff !== "manual") {
    showOutcome("Finishing in Cerium", `${device.name} is joining your account…`);
    const outcome = await waitForClaim(Date.now() + FINISH_WITHIN_MS);
    if (outcome === "connected") return showConnected();
    if (outcome === "expired") return showExpired();
    error =
      "Cerium on this computer didn't take this sign-in. If you started it here, make sure Cerium is open and connect again.";
  }

  const clerk = await loadClerk(config.body.publishableKey);

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
      const { next, code } = result.body;
      const manual = link.body.handoff === "manual";
      if (manual ? typeof code !== "string" : typeof next !== "string") {
        error = `The relay couldn't connect this ${noun(device)}. Try again.`;
        return;
      }
      finished = true;
      try {
        sessionStorage.removeItem(STORED_LINK);
      } catch {
        // Storage is off; nothing was kept.
      }
      if (manual) return await showCode(code);
      // A browser signs in from its own tab: back to the app, which finishes signing in with the
      // code. A machine's Cerium takes it on this computer and sends the page back here.
      if (isBrowser(device)) {
        location.replace(next);
        return;
      }
      showOutcome("Finishing in Cerium", `${device.name} is joining your account…`);
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
  showOutcome("Sign-in isn't available", "Something went wrong loading this page. Reload to try again."),
);
