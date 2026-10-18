// What an artifact's frame runs (docs/architecture.md §9.1). Built into one script at build time
// (vite.config.ts), so the web client's Content-Security-Policy can admit it by its hash: it must not
// import or reference anything outside this file.

/** The message the runtime posts whenever the artifact's height changes. */
export const HEIGHT_MESSAGE = "cerium-artifact:height";

/**
 * Runs inside the frame: turns `.tabs` sections into tabs, keeps links from navigating the frame and
 * reports the content's height to the transcript.
 */
export function artifactRuntime(message: string) {
  let group = 0;
  for (const tabs of document.querySelectorAll<HTMLElement>(".tabs")) {
    const sections = [...tabs.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.tagName === "SECTION",
    );
    if (sections.length === 0) continue;
    group++;
    const list = document.createElement("div");
    list.className = "tablist";
    list.setAttribute("role", "tablist");
    const buttons = sections.map((section, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.id = `tab-${group}-${index}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", `panel-${group}-${index}`);
      button.append(section.dataset["tab"] ?? `Tab ${index + 1}`);
      section.id = `panel-${group}-${index}`;
      section.setAttribute("role", "tabpanel");
      section.setAttribute("aria-labelledby", button.id);
      return button;
    });
    const select = (selected: number) => {
      buttons.forEach((button, index) => {
        button.setAttribute("aria-selected", String(index === selected));
        button.tabIndex = index === selected ? 0 : -1;
        sections[index]!.hidden = index !== selected;
      });
    };
    buttons.forEach((button, index) => button.addEventListener("click", () => select(index)));
    list.addEventListener("keydown", (event) => {
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (current < 0 || step === undefined) return;
      const next = (current + step + buttons.length) % buttons.length;
      select(next);
      buttons[next]!.focus();
      event.preventDefault();
    });
    list.append(...buttons);
    tabs.prepend(list);
    select(0);
  }

  document.addEventListener(
    "click",
    (event) => {
      if (event.target instanceof Element && event.target.closest("a")) event.preventDefault();
    },
    true,
  );

  const report = () =>
    parent.postMessage(
      { type: message, height: Math.ceil(document.documentElement.getBoundingClientRect().height) },
      "*",
    );
  new ResizeObserver(report).observe(document.documentElement);
}
