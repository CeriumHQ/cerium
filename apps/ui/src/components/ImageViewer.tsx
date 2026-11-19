import { Dialog } from "@base-ui/react/dialog";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ChevronLeft, ChevronRight, Copy, Download, FolderOpen, ImageOff, X } from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";

import { imageAtom, toolImageAtom } from "../backend/files.ts";
import { drivenMachine } from "../backend/machine.ts";
import { revealPlace, shellBridge } from "../backend/shell.ts";
import {
  clampView,
  doubleTapScaleFor,
  FIT,
  maxScaleFor,
  resist,
  swipeCloses,
  swipeStep,
  zoomAt,
  type GalleryImage,
  type Point,
  type View,
} from "./imageView.ts";
import { ContextMenuArea, MenuItem, MenuSeparator } from "./ui/Menu.tsx";

/** The image as a PNG on the clipboard: drawn on a canvas, so any format the page can show works. */
const copyImage = async (url: string) => {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (png) await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
};

/** `name` with an extension, taken from the data URL's type when the name has none. */
const fileNameFor = (name: string, url: string) => {
  if (/\.[a-z\d]{2,5}$/i.test(name)) return name;
  const type = /^data:image\/([a-z\d.+-]+)/i.exec(url)?.[1]?.toLowerCase();
  const extension = type === "jpeg" ? "jpg" : type === "svg+xml" ? "svg" : (type ?? "png");
  return `${name}.${extension}`;
};

/** What a right-click on an image offers: copy it, find its file, or save a copy. */
function ImageMenu({ url, name, path }: { url: string; name: string; path: string | undefined }) {
  const bridge = shellBridge();
  const reveal = path ? bridge?.revealPath : undefined;
  const save = bridge?.saveImage;
  return (
    <>
      <MenuItem icon={Copy} onClick={() => void copyImage(url).catch(() => undefined)}>
        Copy image
      </MenuItem>
      {reveal || save ? <MenuSeparator /> : null}
      {reveal && path ? (
        <MenuItem icon={FolderOpen} onClick={() => void reveal(path)}>
          Show in {revealPlace()}
        </MenuItem>
      ) : null}
      {save ? (
        <MenuItem
          icon={Download}
          // A path on another machine means nothing here; the image's bytes are already in the page.
          onClick={() =>
            void save(drivenMachine() === undefined ? (path ?? url) : url, fileNameFor(name, url)).catch(
              () => undefined,
            )
          }
        >
          Save image as…
        </MenuItem>
      ) : null}
    </>
  );
}

/** Adds the image menu to `children` (one element) when the image has one. */
export function WithImageMenu({
  menu,
  url,
  name,
  path,
  children,
}: {
  menu: boolean;
  url: string;
  name: string;
  path: string | undefined;
  children: ReactElement;
}) {
  return menu ? (
    <ContextMenuArea menu={<ImageMenu url={url} name={name} path={path} />}>{children}</ContextMenuArea>
  ) : (
    children
  );
}

interface GalleryApi {
  /** Opens the viewer on `image`, among the gallery's others when it is one of them. */
  readonly show: (image: GalleryImage, origin: ThumbnailOrigin | undefined) => void;
}

const Gallery = createContext<GalleryApi | undefined>(undefined);

/** The gallery a thumbnail opens into, when one holds it. */
export const useGallery = (): GalleryApi | undefined => use(Gallery);

/**
 * The images of `children` as one gallery: a thumbnail opens the viewer on its image, and the
 * viewer steps from there through all of `images`, which is asked for only while it is open.
 */
export function ImageGallery({
  images,
  children,
}: {
  images: () => ReadonlyArray<GalleryImage>;
  children: ReactNode;
}) {
  const [shown, setShown] = useState<{
    open: boolean;
    current: string;
    opened: GalleryImage;
    origin: ThumbnailOrigin | undefined;
  }>();
  // The same object for good, so the thumbnails that read it don't render again with the gallery.
  const [api] = useState<GalleryApi>(() => ({
    show: (image, origin) => setShown({ open: true, current: image.key, opened: image, origin }),
  }));
  const all = shown ? images() : [];
  // The image opened on stands alone if the gallery has lost it since.
  const gallery = all.some((image) => image.key === shown?.current) ? all : shown ? [shown.opened] : [];
  return (
    <Gallery value={api}>
      {children}
      {shown ? (
        <ImageViewer
          images={gallery}
          current={shown.current}
          open={shown.open}
          origin={shown.origin}
          menu
          onCurrentChange={(current) =>
            setShown((now) => (now?.open && now.opened === shown.opened ? { ...now, current } : now))
          }
          onOpenChange={(open) => setShown((now) => now && { ...now, open })}
          onClosed={() => setShown((now) => (now?.open ? now : undefined))}
        />
      ) : null}
    </Gallery>
  );
}

/**
 * Images over the whole window, one at a time: swiped, clicked or arrowed through, pinched, wheeled
 * or double-tapped into, dragged around once enlarged, and swiped down to close.
 */
export function ImageViewer({
  images,
  current,
  open,
  origin,
  menu,
  onCurrentChange,
  onOpenChange,
  onClosed,
}: {
  images: ReadonlyArray<GalleryImage>;
  /** The key of the image shown. */
  current: string;
  open: boolean;
  origin?: ThumbnailOrigin | undefined;
  /** Whether a right-click on the image offers to copy or save it. */
  menu: boolean;
  onCurrentChange: (key: string) => void;
  onOpenChange: (open: boolean) => void;
  /** Called once the viewer has finished closing. */
  onClosed?: () => void;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(opened) => {
        if (!opened) onClosed?.();
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup className="fixed inset-0 z-50 outline-none data-ending-style:pointer-events-none">
          <Stage
            images={images}
            current={current}
            open={open}
            origin={origin}
            menu={menu}
            onCurrentChange={onCurrentChange}
            onClose={() => onOpenChange(false)}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface ThumbnailFrame {
  readonly rect: DOMRectReadOnly;
  readonly clip: { top: number; right: number; bottom: number; left: number };
  readonly radius: number;
}

interface ThumbnailOrigin {
  readonly key: string;
  readonly url: string;
  readonly element: HTMLImageElement;
  readonly frame: ThumbnailFrame;
}

/** The thumbnail's bounds, including any part clipped by its button or a scrolling ancestor. */
function thumbnailFrame(element: HTMLImageElement): ThumbnailFrame | undefined {
  if (!element.checkVisibility({ visibilityProperty: true })) return;
  const rect = element.getBoundingClientRect();
  let { left, top, right, bottom } = rect;
  left = Math.max(left, 0);
  top = Math.max(top, 0);
  right = Math.min(right, document.documentElement.clientWidth);
  bottom = Math.min(bottom, document.documentElement.clientHeight);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowX, overflowY, opacity } = getComputedStyle(parent);
    if (opacity === "0") return;
    if (overflowX === "visible" && overflowY === "visible") continue;
    const bounds = parent.getBoundingClientRect();
    if (overflowX !== "visible") {
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    if (overflowY !== "visible") {
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
  }
  if (right <= left || bottom <= top) return;
  return {
    rect,
    clip: {
      top: top - rect.top,
      right: rect.right - right,
      bottom: rect.bottom - bottom,
      left: left - rect.left,
    },
    radius: parseFloat(getComputedStyle(element.parentElement ?? element).borderTopLeftRadius) || 0,
  };
}

/** Capture where the click came from before the dialog changes focus or locks scrolling. */
export function thumbnailOrigin(key: string, element: HTMLImageElement | null): ThumbnailOrigin | undefined {
  if (!element?.naturalWidth) return;
  const frame = thumbnailFrame(element);
  if (frame) return { key, element, frame, url: element.src };
}

const fittedFrame = { transform: "none", clipPath: "inset(0% round 0px)" };

/** Covers the thumbnail's box the same way as object-cover, with the extra image clipped away. */
function thumbnailKeyframe(image: HTMLImageElement, frame: ThumbnailFrame): Keyframe | undefined {
  const base = image.getBoundingClientRect();
  if (!base.width || !base.height || !image.naturalWidth) return;
  const { rect, clip, radius } = frame;
  const scale = Math.max(rect.width / base.width, rect.height / base.height);
  const parentScale = base.width / image.offsetWidth;
  const width = base.width * scale;
  const height = base.height * scale;
  const x = (rect.left + rect.width / 2 - base.left - base.width / 2) / parentScale;
  const y = (rect.top + rect.height / 2 - base.top - base.height / 2) / parentScale;
  const insetX = (width - rect.width) / 2;
  const insetY = (height - rect.height) / 2;
  return {
    transform: `translate(${x}px, ${y}px) scale(${scale})`,
    clipPath: `inset(${((insetY + clip.top) / height) * 100}% ${((insetX + clip.right) / width) * 100}% ${((insetY + clip.bottom) / height) * 100}% ${((insetX + clip.left) / width) * 100}% round ${radius / (parentScale * scale)}px)`,
  };
}

/** Moves the actual picture, underneath the viewer's independent zoom and pan transforms. */
function useThumbnailTransition(
  stage: RefObject<HTMLDivElement | null>,
  picture: RefObject<HTMLImageElement | null>,
  open: boolean,
  origin: ThumbnailOrigin | undefined,
  canTravel: boolean,
) {
  const motion = useRef<{
    open: boolean;
    origin: ThumbnailOrigin | undefined;
    animations: Animation[];
    paused: Animation[];
    flight?: { image: HTMLImageElement; animation: Animation };
  }>(undefined);
  useLayoutEffect(() => {
    const previous = motion.current;
    if (previous?.open === open && previous.origin === origin) return;
    const layer = stage.current;
    const popup = layer?.closest<HTMLElement>('[role="dialog"]');
    if (!layer || !popup) return;
    const image = picture.current;
    const popupStyle = getComputedStyle(popup);
    const chromeOpacity = previous ? popupStyle.getPropertyValue("--image-viewer-opacity") : "0";
    const layerOpacity = previous ? getComputedStyle(layer).opacity : "0";
    const flight = previous?.flight;
    // A reversal starts from the frame actually on screen, before releasing the old animations.
    const style =
      image &&
      flight?.image === image &&
      image.src === previous?.origin?.url &&
      (flight.animation.playState !== "finished" || !previous.open)
        ? getComputedStyle(image)
        : undefined;
    const moving = style ? { transform: style.transform, clipPath: style.clipPath } : undefined;
    for (const animation of previous?.animations ?? []) animation.cancel();
    for (const animation of previous?.paused ?? []) animation.play();

    const next: NonNullable<typeof motion.current> = { open, origin, animations: [], paused: [] };
    motion.current = next;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame =
      canTravel && !reduced && origin && image?.src === origin.url && origin.element.src === origin.url
        ? open
          ? origin.frame
          : thumbnailFrame(origin.element)
        : undefined;
    // Hold the exact settling zoom or pan frame while measuring and flying back to the thumbnail.
    if (image && frame && !open) {
      for (let parent = image.parentElement; parent && parent !== layer; parent = parent.parentElement) {
        for (const transition of parent.getAnimations()) {
          if (!(transition instanceof CSSTransition) || transition.transitionProperty !== "transform")
            continue;
          const time = transition.currentTime ?? 0;
          transition.pause();
          transition.currentTime = time;
          next.paused.push(transition);
        }
      }
    }
    const target = image && frame ? thumbnailKeyframe(image, frame) : undefined;
    if (!target) for (const animation of next.paused.splice(0)) animation.play();
    const opacity = open ? "1" : "0";
    const photoOpacity = target ? "1" : opacity;
    popup.style.setProperty("--image-viewer-opacity", opacity);
    layer.style.setProperty("opacity", photoOpacity);
    if (reduced) return;

    const timing: KeyframeAnimationOptions = {
      duration: open ? 280 : 240,
      easing: popupStyle.getPropertyValue(open ? "--ease-out-soft" : "--ease-in-soft").trim(),
      fill: "backwards",
    };
    // The popup owns the chrome's fade, so Base UI keeps the dialog mounted through the exit.
    next.animations.push(popup.animate({ "--image-viewer-opacity": [chromeOpacity, opacity] }, timing));
    if (layerOpacity !== photoOpacity && (previous || !target)) {
      next.animations.push(layer.animate({ opacity: [layerOpacity, photoOpacity] }, timing));
    }
    if (!image || (!target && !moving)) return;
    const from = moving ?? (open ? target : undefined) ?? fittedFrame;
    const to = open ? fittedFrame : (target ?? from);
    const animation = image.animate([from, to], { ...timing, fill: open ? "backwards" : "both" });
    next.flight = { image, animation };
    next.animations.push(animation);
    if (target && origin) {
      next.animations.push(
        origin.element.animate({ opacity: [0, 0] }, { ...timing, fill: open ? "backwards" : "both" }),
      );
    }
  });
  useLayoutEffect(
    () => () => {
      const state = motion.current;
      for (const animation of state?.animations ?? []) animation.cancel();
      for (const animation of state?.paused ?? []) animation.cancel();
      motion.current = undefined;
    },
    [],
  );
}

/** The room between one image and the next as they slide. */
const GAP = 24;

/** How long a slide to the next image, or back into place, takes. */
const SETTLE_MS = 240;

/** How far a pointer moves before a press is a drag rather than a tap. */
const SLOP = 6;

/** How soon a second tap makes a double tap. */
const DOUBLE_TAP_MS = 300;

type Gesture =
  /** One pointer down, not yet moved far enough to say what it does. */
  | { readonly kind: "press"; readonly start: Point; readonly at: number; readonly view: View }
  /** Moving an enlarged image around. */
  | { readonly kind: "pan"; readonly start: Point; readonly view: View }
  /** Sliding toward the next or previous image. */
  | { readonly kind: "swipe"; readonly start: Point }
  /** Pulling the image down to close. */
  | { readonly kind: "drop"; readonly start: Point }
  /** Two pointers scaling the image. */
  | { readonly kind: "pinch"; readonly distance: number; readonly mid: Point; readonly view: View };

/** A pointer's speed along one axis, in pixels per millisecond, smoothed over its last moves. */
interface Velocity {
  value: number;
  at: number;
  position: number;
}

const track = (velocity: Velocity, position: number) => {
  const now = performance.now();
  const elapsed = now - velocity.at;
  if (elapsed > 0) {
    velocity.value = 0.6 * ((position - velocity.position) / elapsed) + 0.4 * velocity.value;
  }
  velocity.at = now;
  velocity.position = position;
};

function Stage({
  images,
  current,
  open,
  origin,
  menu,
  onCurrentChange,
  onClose,
}: {
  images: ReadonlyArray<GalleryImage>;
  current: string;
  open: boolean;
  origin: ThumbnailOrigin | undefined;
  menu: boolean;
  onCurrentChange: (key: string) => void;
  onClose: () => void;
}) {
  const index = Math.max(
    0,
    images.findIndex((image) => image.key === current),
  );
  const [selection, setSelection] = useState({ current, open });
  const [view, setView] = useState<View>(FIT);
  /** How far the row of images is slid sideways. */
  const [offset, setOffset] = useState(0);
  /** How far the image is pulled down toward closing. */
  const [drop, setDrop] = useState(0);
  /** A pointer is moving things, which follow it without easing. */
  const [dragging, setDragging] = useState(false);
  /** The row is being put back under the image just arrived, which mustn't be seen to move. */
  const [swapping, setSwapping] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>(undefined);
  const velocity = useRef<Velocity>({ value: 0, at: 0, position: 0 });
  const lastTap = useRef<{ at: number; point: Point }>(undefined);
  const settle = useRef<number>(undefined);
  const image = images[index];

  if (selection.current !== current || selection.open !== open) {
    setSelection({ current, open });
    if (selection.current !== current) setView(FIT);
    if (open && !selection.open) {
      setDrop(0);
      setOffset(0);
      setDragging(false);
    }
  }

  useThumbnailTransition(
    stage,
    picture,
    open,
    origin,
    origin?.key === current && image?.key === current && (open || offset === 0),
  );

  useLayoutEffect(() => {
    if (open) return;
    // A pending slide belongs to the opening that just closed.
    window.clearTimeout(settle.current);
    settle.current = undefined;
    pointers.current.clear();
    gesture.current = undefined;
    lastTap.current = undefined;
  }, [open]);
  useEffect(() => () => window.clearTimeout(settle.current), []);

  /** The sizes the zoom works within, measured as they are now. */
  const measure = () => {
    const width = stage.current?.clientWidth ?? 0;
    const height = stage.current?.clientHeight ?? 0;
    const image = picture.current;
    const fitted = { width: image?.offsetWidth ?? 0, height: image?.offsetHeight ?? 0 };
    const natural = { width: image?.naturalWidth ?? 0, height: image?.naturalHeight ?? 0 };
    return { stage: { width, height }, fitted, max: maxScaleFor(natural, fitted) };
  };

  const bounded = (next: View) => {
    const { stage: size, fitted, max } = measure();
    return clampView(next, fitted, size, max);
  };

  /** A point in the window, measured from the stage's centre, where the fitted image's centre is. */
  const fromCentre = (x: number, y: number): Point => {
    const rect = stage.current?.getBoundingClientRect();
    return rect ? { x: x - rect.left - rect.width / 2, y: y - rect.top - rect.height / 2 } : { x: 0, y: 0 };
  };

  const go = (step: -1 | 1) => {
    const next = images[index + step];
    if (!next || settle.current !== undefined) return;
    setOffset(-step * ((stage.current?.clientWidth ?? 0) + GAP));
    settle.current = window.setTimeout(() => {
      settle.current = undefined;
      setSwapping(true);
      onCurrentChange(next.key);
      setOffset(0);
      requestAnimationFrame(() => requestAnimationFrame(() => setSwapping(false)));
    }, SETTLE_MS);
  };

  const zoomTo = (scale: number, at: Point) => setView((now) => bounded(zoomAt(now, scale, at)));

  // Not React's wheel handler: that one is passive, and Ctrl+wheel would zoom the whole window.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const at = fromCentre(event.clientX, event.clientY);
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002));
      setView((now) => bounded(zoomAt(now, now.scale * factor, at)));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  });

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = fromCentre(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      setOffset(0);
      setDrop(0);
      gesture.current = {
        kind: "pinch",
        distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view,
      };
    } else if (pointers.current.size === 1) {
      gesture.current = { kind: "press", start: point, at: performance.now(), view };
    }
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = fromCentre(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, point);
    const now = gesture.current;
    if (!now) return;
    if (now.kind === "pinch") {
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const scale = now.view.scale * (Math.hypot(a.x - b.x, a.y - b.y) / now.distance);
      const zoomed = zoomAt(now.view, scale, now.mid);
      setView(bounded({ ...zoomed, x: zoomed.x + mid.x - now.mid.x, y: zoomed.y + mid.y - now.mid.y }));
      return;
    }
    const dx = point.x - ("start" in now ? now.start.x : 0);
    const dy = point.y - ("start" in now ? now.start.y : 0);
    if (now.kind === "press") {
      if (Math.hypot(dx, dy) < SLOP) return;
      const next: Gesture =
        now.view.scale > 1
          ? { kind: "pan", start: now.start, view: now.view }
          : Math.abs(dx) > Math.abs(dy)
            ? { kind: "swipe", start: now.start }
            : { kind: "drop", start: now.start };
      gesture.current = next;
      velocity.current = {
        value: 0,
        at: performance.now(),
        position: next.kind === "drop" ? point.y : point.x,
      };
      return;
    }
    if (now.kind === "pan") {
      setView(bounded({ ...now.view, x: now.view.x + dx, y: now.view.y + dy }));
    } else if (now.kind === "swipe") {
      track(velocity.current, point.x);
      const pastEnd = (dx > 0 && index === 0) || (dx < 0 && index === images.length - 1);
      setOffset(pastEnd ? resist(dx) : dx);
    } else {
      track(velocity.current, point.y);
      setDrop(Math.max(0, dy));
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const now = gesture.current;
    const point = fromCentre(event.clientX, event.clientY);
    if (now?.kind === "pinch") {
      // The finger still down carries on moving the image from where it is.
      const rest = [...pointers.current.values()][0];
      gesture.current = rest ? { kind: "pan", start: rest, view } : undefined;
      if (!rest) {
        setDragging(false);
        if (view.scale < 1.02) setView(FIT);
      }
      return;
    }
    if (pointers.current.size > 0) return;
    gesture.current = undefined;
    setDragging(false);
    if (!now) return;
    const size = measure().stage;
    if (now.kind === "swipe") {
      const step = event.type === "pointercancel" ? 0 : swipeStep(offset, velocity.current.value, size.width);
      if (step !== 0 && images[index + step]) go(step);
      else setOffset(0);
    } else if (now.kind === "drop") {
      if (event.type !== "pointercancel" && swipeCloses(drop, velocity.current.value, size.height)) onClose();
      else setDrop(0);
    } else if (now.kind === "press" && event.type !== "pointercancel") {
      tap(point, event.clientX, event.clientY);
    }
  };

  /** A tap or click: twice on the image zooms in or back out; once beside a fitted image closes. */
  const tap = (point: Point, clientX: number, clientY: number) => {
    // Measured, not the event's target: the stage captures the pointer, so it is always the target.
    const rect = picture.current?.getBoundingClientRect();
    const on =
      rect !== undefined &&
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom;
    const before = lastTap.current;
    const at = performance.now();
    if (
      on &&
      before &&
      at - before.at < DOUBLE_TAP_MS &&
      Math.hypot(point.x - before.point.x, point.y - before.point.y) < 30
    ) {
      lastTap.current = undefined;
      if (view.scale > 1) setView(FIT);
      else zoomTo(doubleTapScaleFor(measure().max), point);
      return;
    }
    lastTap.current = on ? { at, point } : undefined;
    if (!on && view.scale === 1) onClose();
  };

  // The viewer is modal, so the arrow keys are its own wherever focus sits in it: taken as they
  // come down, before the window's own shortcuts can use them.
  useEffect(() => {
    if (!open) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", keyDown, true);
    return () => window.removeEventListener("keydown", keyDown, true);
  });

  const eased = !dragging && !swapping;
  const many = images.length > 1;
  return (
    <div className="absolute inset-0">
      <div
        className="absolute inset-0 bg-surface-overlay backdrop-blur-2xl"
        style={{ opacity: `calc(var(--image-viewer-opacity) * ${1 - Math.min(drop / 400, 0.7)})` }}
      />
      <div
        ref={stage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`absolute inset-0 touch-none overflow-hidden select-none ${
          view.scale > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
        }`}
      >
        <div
          className={`absolute inset-0 ${eased ? "transition-transform duration-240 ease-out-soft" : ""}`}
          style={{ transform: `translateX(${offset}px)` }}
        >
          {images.map((each, at) =>
            Math.abs(at - index) > 1 ? null : (
              <div
                key={each.key}
                className="absolute inset-0 px-0 py-[calc(3.5rem+max(env(safe-area-inset-top),env(safe-area-inset-bottom)))] md:px-20 md:pt-[calc(4rem+env(titlebar-area-height,0px))] md:pb-16"
                style={{ transform: `translateX(calc(${at - index} * (100% + ${GAP}px)))` }}
              >
                {at === index ? (
                  <div
                    className={`relative size-full ${eased ? "transition-transform duration-200 ease-out-soft" : ""}`}
                    style={{
                      transform: `translate(${view.x}px, ${view.y + drop}px) scale(${view.scale * (1 - Math.min(drop / 2000, 0.15))})`,
                    }}
                  >
                    <Slide image={each} menu={menu} zoomed={view.scale > 1} pictureRef={picture} />
                  </div>
                ) : (
                  <div className="relative size-full">
                    <Slide image={each} menu={false} zoomed={false} />
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      </div>
      {/* Under the titlebar's height in the desktop app, whose caption buttons the system draws over
          every page: the close button sits clear of them. */}
      <div
        className={`pointer-events-none absolute inset-0 opacity-(--image-viewer-opacity) ${
          open ? "[&>*]:pointer-events-auto" : ""
        }`}
      >
        <div
          className="absolute inset-x-0 top-[env(titlebar-area-height,0px)] flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center gap-3 px-4 pt-[env(safe-area-inset-top)] transition-opacity duration-200"
          style={{ opacity: drop > 0 ? 0 : 1 }}
        >
          <Dialog.Title className="flex min-w-0 flex-1 items-baseline gap-2 text-meta">
            <span className="min-w-0 truncate text-fg-secondary">{image?.name}</span>
            {many ? (
              <span className="shrink-0 text-fg-tertiary tabular-nums">
                {index + 1} / {images.length}
              </span>
            ) : null}
          </Dialog.Title>
          <Dialog.Close aria-label="Close" className={chromeButton}>
            <X size={16} strokeWidth={2} />
          </Dialog.Close>
        </div>
        {many ? (
          <>
            <ChromeArrow side="left" hidden={index === 0} onClick={() => go(-1)} />
            <ChromeArrow side="right" hidden={index === images.length - 1} onClick={() => go(1)} />
          </>
        ) : null}
      </div>
    </div>
  );
}

const chromeButton =
  "grid size-9 shrink-0 place-items-center rounded-full border border-line-subtle bg-surface-raised text-fg-secondary shadow-raised backdrop-blur-xl transition-[color,opacity] duration-150 outline-none hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent";

/** The way to the previous or next image beside it, for a mouse; a finger swipes. */
function ChromeArrow({
  side,
  hidden,
  onClick,
}: {
  side: "left" | "right";
  hidden: boolean;
  onClick: () => void;
}) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous image" : "Next image"}
      onClick={onClick}
      inert={hidden}
      className={`${chromeButton} absolute top-1/2 -translate-y-1/2 pointer-coarse:hidden ${
        side === "left" ? "left-5" : "right-5"
      } ${hidden ? "opacity-0" : ""}`}
    >
      <Icon size={18} strokeWidth={2} />
    </button>
  );
}

/** One image of the viewer, read first when it isn't in the page yet. */
function Slide({
  image,
  menu,
  zoomed,
  pictureRef,
}: {
  image: GalleryImage;
  menu: boolean;
  zoomed: boolean;
  pictureRef?: Ref<HTMLImageElement>;
}) {
  const shown = { name: image.name, path: image.path, menu, zoomed, pictureRef };
  if (image.url) return <Picture url={image.url} {...shown} />;
  if (image.ref) return <RefSlide imageRef={JSON.stringify(image.ref)} {...shown} />;
  if (image.path) return <PathSlide {...shown} file={image.path} />;
  return <Unshown />;
}

type PictureProps = {
  name: string;
  path: string | undefined;
  menu: boolean;
  zoomed: boolean;
  pictureRef: Ref<HTMLImageElement> | undefined;
};

function PathSlide({ file, ...shown }: PictureProps & { file: string }) {
  return <Loaded result={useAtomValue(imageAtom(file))} {...shown} />;
}

function RefSlide({ imageRef, ...shown }: PictureProps & { imageRef: string }) {
  return <Loaded result={useAtomValue(toolImageAtom(imageRef))} {...shown} />;
}

function Loaded({ result, ...shown }: PictureProps & { result: AsyncResult.AsyncResult<string, unknown> }) {
  if (AsyncResult.isSuccess(result)) return <Picture url={result.value} {...shown} />;
  if (AsyncResult.isFailure(result)) return <Unshown />;
  return <span className="absolute inset-0 m-auto size-24 animate-pulse rounded-xl bg-surface-hover" />;
}

function Unshown() {
  return (
    <span className="absolute inset-0 m-auto flex h-fit flex-col items-center gap-2 text-meta text-fg-tertiary">
      <ImageOff size={20} strokeWidth={1.5} />
      This image can't be shown
    </span>
  );
}

function Picture({ url, name, path, menu, zoomed, pictureRef }: PictureProps & { url: string }) {
  return (
    <WithImageMenu menu={menu} url={url} name={name} path={path}>
      <img
        ref={pictureRef}
        src={url}
        alt={name}
        draggable={false}
        decoding="async"
        // Centred by its margins: a grid would size its cell to a large image and let it overflow.
        className={`absolute inset-0 m-auto max-h-full max-w-full object-contain shadow-overlay md:rounded-lg md:border md:border-line-subtle ${
          zoomed ? "" : "cursor-zoom-in"
        }`}
      />
    </WithImageMenu>
  );
}
