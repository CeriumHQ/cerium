// A message sent from the box flies to where the transcript shows it. Sending clears the box at once,
// but the message only reaches the transcript once the machine has it, so its text is held where it
// was written until its bubble mounts and takes it; then the bubble flies from there to its place.

/** How long the text waits in the box for its bubble before it lifts away on its own. */
const WAIT_MS = 1_500;
const FLIGHT_MS = 560;

interface Launch {
  readonly text: string;
  /** Where the message's text started in the box, in the window. */
  readonly x: number;
  readonly y: number;
  /** The text as it was written, held over the box until the flight takes over from it. */
  readonly held: HTMLElement;
  readonly expire: ReturnType<typeof setTimeout>;
}

let waiting: Launch | undefined;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** An element laid over the window that copies `source` as it stands, and takes no pointer. */
const overlay = (source: HTMLElement, rect: DOMRect): HTMLElement => {
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;z-index:60;pointer-events:none;margin:0`;
  const copy = source.cloneNode(true) as HTMLElement;
  for (const each of [copy, ...copy.querySelectorAll<HTMLElement>("[id],[contenteditable],[role]")]) {
    each.removeAttribute("id");
    each.removeAttribute("contenteditable");
    each.removeAttribute("role");
    each.removeAttribute("tabindex");
  }
  // The copy takes the width the source had, and whatever zoom scaled it, so its lines wrap alike.
  const zoom = source.offsetWidth > 0 ? rect.width / source.offsetWidth : 1;
  copy.style.width = `${source.offsetWidth}px`;
  copy.style.margin = "0";
  copy.style.zoom = String(zoom);
  layer.append(copy);
  document.body.append(layer);
  return layer;
};

/** Lets the held text go: lifting and fading away when no bubble came for it, or at once. */
const release = (launch: Launch, lift: boolean) => {
  clearTimeout(launch.expire);
  if (waiting === launch) waiting = undefined;
  if (!lift) {
    launch.held.remove();
    return;
  }
  const leaving = launch.held.animate([{ translate: "0 -10px", opacity: 0, filter: "blur(2px)" }], {
    duration: 220,
    easing: "cubic-bezier(0.45, 0, 0.75, 0.3)",
    fill: "forwards",
  });
  void leaving.finished.then(
    () => launch.held.remove(),
    () => launch.held.remove(),
  );
};

/**
 * Holds a message just sent where it was written: `editor` is the box's editable text, as it stands
 * before the send clears it. Its bubble, mounting in the transcript, takes it with `takeLaunch`.
 */
export function launch(editor: HTMLElement, text: string) {
  if (waiting) release(waiting, false);
  if (reduced() || text.trim() === "") return;
  const rect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const held = overlay(editor, rect);
  // The box scrolls a long draft; the copy shows the part that was in view.
  const copy = held.firstElementChild as HTMLElement;
  copy.style.height = `${editor.offsetHeight}px`;
  copy.style.overflow = "hidden";
  copy.scrollTop = editor.scrollTop;
  const sent: Launch = {
    text: text.trim(),
    x: rect.left + editor.clientLeft + parseFloat(style.paddingLeft),
    y: rect.top + editor.clientTop + parseFloat(style.paddingTop),
    held,
    expire: setTimeout(() => release(sent, true), WAIT_MS),
  };
  waiting = sent;
}

/**
 * Where the bubble lands: where it stands, less the rise that lifts its message into place, and never
 * lower than the flight began. The bubble always ends above the box, but while the transcript glides
 * to its end it can stand lower for a moment, which would pull the flight down before it climbs.
 */
const landing = (bubble: HTMLElement, floor: number) => {
  const rect = bubble.getBoundingClientRect();
  const rising = bubble.closest<HTMLElement>(".arrive");
  const rise = rising ? parseFloat(getComputedStyle(rising).translate.split(" ")[1] ?? "0") : 0;
  return { left: rect.left, top: Math.min(floor, rect.top - (Number.isNaN(rise) ? 0 : rise)) };
};

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Flies `bubble`, a message the transcript just showed, from where its text was written in the box,
 * if it's the one that was sent: a copy of it starts as the bare text in the box and rises to the
 * bubble while its surface forms around it, and the bubble shows once it lands. It follows the bubble
 * as the transcript scrolls under it, and stops once the bubble has left the page.
 */
export function takeLaunch(bubble: HTMLElement, text: string) {
  const sent = waiting;
  if (!sent || sent.text !== text.trim()) return;
  clearTimeout(sent.expire);
  waiting = undefined;

  const start = bubble.getBoundingClientRect();
  const zoom = bubble.offsetWidth > 0 ? start.width / bubble.offsetWidth : 1;
  const style = getComputedStyle(bubble);
  // Where the bubble's text starts inside it, so the copy's text starts where the box's did.
  const inset = {
    x: (bubble.clientLeft + parseFloat(style.paddingLeft)) * zoom,
    y: (bubble.clientTop + parseFloat(style.paddingTop)) * zoom,
  };
  const flying = overlay(bubble, start);
  const copy = flying.firstElementChild as HTMLElement;
  const from = { x: sent.x - inset.x, y: sent.y - inset.y };
  const place = (x: number, y: number) => {
    flying.style.left = `${x}px`;
    flying.style.top = `${y}px`;
  };
  place(from.x, from.y);
  bubble.style.visibility = "hidden";

  // The surface forms around the text as it rises: plain text in the box becomes a message.
  const surface = copy.animate(
    [
      { backgroundColor: "transparent", borderColor: "transparent", boxShadow: "none" },
      { offset: 0.25, backgroundColor: "transparent", borderColor: "transparent", boxShadow: "none" },
      {},
    ],
    { duration: FLIGHT_MS, easing: "ease-out", fill: "backwards" },
  );
  // The text as written hands over to the copy, riding along as it fades, so differently wrapped
  // lines cross over rather than jump.
  const held = sent.held;
  const handover = held.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 140,
    easing: "ease-out",
    fill: "forwards",
  });

  let frame = 0;
  // Timed from its first frame, so a slow render before it doesn't eat into the flight.
  let began: number | undefined;
  const end = () => {
    cancelAnimationFrame(frame);
    surface.cancel();
    handover.cancel();
    held.remove();
    flying.remove();
    bubble.style.visibility = "";
  };
  const step = (now: number) => {
    if (!bubble.isConnected) {
      end();
      return;
    }
    began ??= now;
    const t = Math.min(1, (now - began) / FLIGHT_MS);
    const to = landing(bubble, from.y);
    // It rises sooner than it crosses, so it arcs up out of the box and over to its side.
    const x = from.x + (to.left - from.x) * easeInOut(t);
    const y = from.y + (to.top - from.y) * easeOut(t);
    place(x, y);
    held.style.translate = `${x - from.x}px ${y - from.y}px`;
    if (t < 1) frame = requestAnimationFrame(step);
    else end();
  };
  frame = requestAnimationFrame(step);
}
