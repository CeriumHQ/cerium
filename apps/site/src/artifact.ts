// The artifact beside "Answers you can drag": a small simulator of a job queue's rate limit, of the
// kind an agent answers with in a thread. It runs here, so the page shows the feature by being one.

const JOBS = 24;
/** Each job's length in milliseconds: fixed, so the same settings always draw the same timeline. */
const lengths = Array.from({ length: JOBS }, (_, job) => 28 + ((job * 37 + 11) % 41));

/** When each job starts: once a slot is free, and once `count` starts ago is a whole `interval` behind. */
const schedule = (count: number, interval: number, concurrency: number): Array<number> => {
  const starts: Array<number> = [];
  const free = Array.from({ length: concurrency }, () => 0);
  for (let job = 0; job < JOBS; job++) {
    let slot = 0;
    for (let other = 1; other < free.length; other++) if (free[other]! < free[slot]!) slot = other;
    const allowed = job >= count ? starts[job - count]! + interval : 0;
    const start = Math.max(free[slot]!, allowed);
    starts.push(start);
    free[slot] = start + lengths[job]!;
  }
  return starts;
};

const finish = (starts: ReadonlyArray<number>) =>
  Math.max(...starts.map((start, job) => start + lengths[job]!));

const WIDTH = 600;
const HEIGHT = 232;
const LEFT = 22;
const TOP = 40;
const ROW = 7;

const draw = (starts: ReadonlyArray<number>, total: number, unlimited: number): string => {
  const scale = (WIDTH - LEFT - 8) / total;
  const x = (time: number) => LEFT + time * scale;
  const step = [20, 50, 100, 200, 500].find((each) => total / each <= 6) ?? 1000;
  const parts: Array<string> = [];
  for (let tick = 0; tick <= total; tick += step) {
    parts.push(`<text x="${x(tick)}" y="${HEIGHT - 4}">${tick}${tick === 0 ? " ms" : ""}</text>`);
  }
  // Starts that share a moment stack up from the timeline.
  const stacked = new Map<number, number>();
  starts.forEach((start, job) => {
    const y = TOP + job * ROW;
    if (job % 4 === 0) parts.push(`<text x="${LEFT - 6}" y="${y + 6}" text-anchor="end">${job + 1}</text>`);
    parts.push(`<line class="grid" x1="${LEFT}" x2="${WIDTH - 8}" y1="${y + 6}" y2="${y + 6}" />`);
    parts.push(
      `<rect class="run" x="${x(start)}" y="${y}" width="${Math.max(2, lengths[job]! * scale)}" height="5" rx="1.5" />`,
    );
    const above = stacked.get(start) ?? 0;
    stacked.set(start, above + 1);
    parts.push(`<circle class="start" cx="${x(start) + 2}" cy="${TOP - 8 - above * 4}" r="1.6" />`);
  });
  if (unlimited < total) {
    parts.push(`<line class="free" x1="${x(unlimited)}" x2="${x(unlimited)}" y1="12" y2="${HEIGHT - 18}" />`);
    parts.push(
      `<text class="free-label" x="${x(unlimited) - 5}" y="9" text-anchor="end">no limit: ${unlimited} ms</text>`,
    );
  }
  return parts.join("");
};

export const startArtifact = (root: HTMLElement) => {
  const knobs = [...root.querySelectorAll<HTMLInputElement>("[data-knob]")];
  const chart = root.querySelector<SVGElement>("[data-chart]")!;
  chart.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
  const say = (name: string, text: string) => {
    for (const each of root.querySelectorAll(`[data-stat="${name}"], [data-out="${name}"]`))
      each.textContent = text;
  };
  const update = () => {
    const value = Object.fromEntries(knobs.map((knob) => [knob.dataset.knob!, Number(knob.value)]));
    for (const knob of knobs) {
      const min = Number(knob.min);
      knob.style.setProperty("--fill", `${((Number(knob.value) - min) / (Number(knob.max) - min)) * 100}%`);
    }
    const count = value["count"]!;
    const interval = value["interval"]!;
    const concurrency = value["concurrency"]!;
    const starts = schedule(count, interval, concurrency);
    const total = finish(starts);
    const unlimited = finish(schedule(JOBS, 0, concurrency));
    const peak = Math.max(
      ...starts.map((start) => starts.filter((other) => other >= start && other < start + interval).length),
    );
    say("count", String(count));
    say("interval", `${interval} ms`);
    say("concurrency", String(concurrency));
    say("total", String(total));
    say("free", `${unlimited} ms unlimited`);
    say("peak", String(Math.min(peak, count)));
    say("wait", String(Math.max(...starts)));
    chart.innerHTML = draw(starts, total, unlimited);
  };
  for (const knob of knobs) knob.addEventListener("input", update);
  update();
};
