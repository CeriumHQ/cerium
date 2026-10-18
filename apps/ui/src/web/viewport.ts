// The phone's keyboard (docs/architecture.md §14.10). iOS shrinks the visible part of the page for
// it without resizing the page, and scrolls the page to show the focused field, which would leave the
// message box under the keyboard or the top bar off the screen. So the window follows the visible
// part instead: app.css sizes and places #root by these properties.

export const followVisualViewport = () => {
  const visible = window.visualViewport;
  if (visible === null) return;
  const root = document.documentElement.style;
  const update = () => {
    root.setProperty("--app-height", `${visible.height}px`);
    root.setProperty("--app-top", `${visible.offsetTop}px`);
  };
  visible.addEventListener("resize", update);
  visible.addEventListener("scroll", update);
  update();
};
