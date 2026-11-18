let pending = 0;

/** Keeps the window alive while it holds work that a replacement renderer couldn't resume. */
export const holdRenderer = (): (() => void) => {
  const setBusy = window.cerium?.setRendererBusy;
  if (setBusy === undefined) return () => {};
  if (pending++ === 0) setBusy(true);
  return () => {
    if (--pending === 0) setBusy(false);
  };
};
