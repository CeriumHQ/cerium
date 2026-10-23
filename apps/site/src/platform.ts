// Which build fits the visitor's machine, as far as the browser says. A visitor on Linux gets the
// package their distribution installs when their browser names it (Ubuntu's and Fedora's Firefox
// do), else the AppImage; on an Arm64 processor, each one's Arm64 build. Chromium names the processor
// only when asked, and other browsers on Windows never do. A Mac gets Apple silicon's disk image, or
// Intel's where Chromium says it has one; every Mac browser claims Intel in its user agent and Safari
// says no more. An iPad asking for the desktop site says Macintosh as well, but has a touch screen.
// Each path is one of the relay's `/download` redirects (apps/relay/scripts/layout.ts).

const userAgent = navigator.userAgent;
export const linux = /Linux/.test(userAgent) && !/Android/.test(userAgent);
export const mac = /Macintosh/.test(userAgent) && navigator.maxTouchPoints < 2;
const windows = /Windows/.test(userAgent);

/** The system the download buttons name, where it isn't Windows. */
export const system = linux
  ? { mark: "#mark-linux", name: "Linux" }
  : mac
    ? { mark: "#mark-apple", name: "Mac" }
    : undefined;

/** The path of the build for this machine, or Windows' x64 installer where the browser doesn't say. */
export const download = (arm: boolean): string => {
  if (mac) return arm ? "/download/mac" : "/download/mac-intel";
  if (!linux) return arm && windows ? "/download/windows-arm64" : "/download";
  const kind = /Ubuntu|Debian|Mint/.test(userAgent)
    ? "deb"
    : /Fedora|Red Hat/.test(userAgent)
      ? "rpm"
      : "linux";
  return `/download/${kind}${arm ? "-arm64" : ""}`;
};

/** A first guess at the processor: Arm64 on a Mac, and wherever the user agent names it. */
export const armGuess = mac || /aarch64|arm64/i.test(userAgent);

const hints = (
  navigator as Navigator & {
    readonly userAgentData?: {
      getHighEntropyValues(hints: ReadonlyArray<string>): Promise<{ readonly architecture?: string }>;
    };
  }
).userAgentData;

/** Calls `onArm` with the processor, when Chromium names one the first guess may have missed. */
export const askProcessor = (onArm: (arm: boolean) => void) => {
  void hints
    ?.getHighEntropyValues(["architecture"])
    .then(({ architecture }) => {
      if (architecture === "arm") onArm(true);
      else if (mac && architecture === "x86") onArm(false);
    })
    .catch(() => undefined);
};
