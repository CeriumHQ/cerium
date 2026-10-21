// The story's camera: as each step reaches the middle of the screen, the window shows the frame the
// step is about and moves in on the part of it that matters. Each shot is the left edge, top and width
// of what the window shows, in the captures' own CSS pixels (a 1280 by 800 window); the window's shape
// decides the height. Edges fall inside one of the app's panels, so no stray sliver of the next shows.

const WIDTH = 1280;
const HEIGHT = 800;

interface Shot {
  readonly frame: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

// The conversation's column of messages runs from 296 to 932.
const shots: ReadonlyArray<Shot> = [
  // The request, and the lead getting started.
  { frame: "ask", x: 296, y: 70, width: 636 },
  // The three helpers' cards, and the lead warning the project's other threads.
  { frame: "team", x: 296, y: 236, width: 636 },
  // Pulled back: the agents panel with all four working.
  { frame: "team", x: 282, y: 30, width: 998 },
  // The lead's table of who did what.
  { frame: "answer", x: 296, y: 176, width: 636 },
];

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export const startStory = (section: HTMLElement) => {
  const stage = section.querySelector<HTMLElement>("[data-stage]");
  const camera = section.querySelector<HTMLElement>("[data-camera]");
  const steps = [...section.querySelectorAll<HTMLElement>("[data-step]")];
  if (stage === null || camera === null || steps.length === 0) return;
  const frames = [...camera.querySelectorAll<HTMLElement>("[data-frame]")];
  let current = 0;

  const show = (index: number) => {
    current = index;
    const shot = shots[index]!;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    // Never so far out that the window shows past the frame's edge.
    const scale = Math.max(width / shot.width, width / WIDTH, height / HEIGHT);
    const x = clamp(-shot.x * scale, width - WIDTH * scale, 0);
    const y = clamp(-shot.y * scale, height - HEIGHT * scale, 0);
    camera.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    for (const frame of frames) frame.toggleAttribute("data-on", frame.dataset["frame"] === shot.frame);
    for (const step of steps) step.toggleAttribute("data-on", step.dataset["step"] === String(index));
    section.dataset["at"] = String(index);
  };

  // The step crossing the middle of the screen is the one shown.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) show(Number((entry.target as HTMLElement).dataset["step"]));
      }
    },
    { rootMargin: "-50% 0px -50% 0px" },
  );
  for (const step of steps) observer.observe(step);

  // Placed at once on load and resize, so the camera only glides between steps.
  const place = () => {
    camera.style.transition = "none";
    show(current);
    void camera.offsetWidth;
    camera.style.transition = "";
  };
  place();
  new ResizeObserver(place).observe(stage);
};
