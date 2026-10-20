// What agents read, through the bus's `artifact_guide` tool, before writing an artifact. Every theme
// variable it names must be one the document sets; the package's test checks that.

export const artifactGuide = `# Cerium artifacts

An artifact is an HTML page that Cerium shows inline in your reply, right where you write it. You
design it: your own markup, CSS and scripts, on Cerium's theme. Use one when a visual explains better
than prose: a chart, a timeline, a comparison, a status board, a diagram, an interactive what-if, a UI
mockup. Keep short answers, single facts and plain lists in markdown.

## Format

Write a fenced code block with the language \`artifact\`. It holds an HTML fragment (the usual case:
a \`<style>\`, your markup and any \`<script>\`) or a complete document. If the page itself contains
three backticks, fence it with four.

\`\`\`\`
\`\`\`artifact
<style> … </style>
<div class="report"> … </div>
<script> … </script>
\`\`\`
\`\`\`\`

Give it a short \`<title>\`: Cerium shows it while the page is drawn and over its full-size view.
The reader sees the page between your paragraphs, so the prose around it adds only what the page
doesn't say; don't announce or describe it.

## Layout

- The page is as wide as the conversation column, about 720px on a desktop and 360px on a phone, and
  its left edge lines up with your text. Use fluid widths: \`grid-template-columns:
  repeat(auto-fit, minmax(180px, 1fr))\`, flex wrap, percentages. No horizontal padding on the
  outermost element.
- It sits on the conversation's own background. Leave \`html\`, \`body\` and your outermost element
  without a background, border or banner title: the page is part of your reply, not a card in it.
- A box that must stand apart (a panel, a mock of a screen) gets \`var(--card)\` or a border, at least
  16px of padding on every side and \`var(--radius)\` corners.
- The frame grows to the page's height, so let content set it. Never size with \`vh\`, \`svh\` or
  \`dvh\` units or \`height: 100%\` on \`html\`/\`body\`: the frame would grow with the page forever.
  Give charts a fixed pixel height.

## Theme

Cerium sets these variables on \`:root\` and changes them live when the user switches theme or
light/dark mode, so colour everything with them and the page always matches the app:

| Variable | Use |
| --- | --- |
| \`--foreground\`, \`--muted-foreground\`, \`--subtle-foreground\` | Text: primary, secondary, faint |
| \`--card\`, \`--card-foreground\` | A raised surface and its text |
| \`--popover\`, \`--popover-foreground\` | Tooltips, menus, anything floating |
| \`--muted\`, \`--secondary\`, \`--accent\` (+ \`-foreground\`) | Subtle fills: rows, tracks, hover, selected |
| \`--primary\`, \`--primary-foreground\`, \`--primary-soft\` | The theme's accent: solid buttons, the one emphasis |
| \`--border\`, \`--border-strong\`, \`--input\`, \`--ring\` | Hairlines, emphasised edges, fields, focus |
| \`--background\` | The conversation's colour, opaque: for sticky headers or masks, not page backgrounds |
| \`--success\`, \`--warning\`, \`--destructive\`, \`--info\` | Status only: done, needs attention, failed, in progress |
| \`--chart-1\` … \`--chart-8\` | Categorical colours, validated for colour-blind separation in this order |
| \`--shadow\`, \`--shadow-lg\` | Raised and floating shadows |
| \`--radius\` (10px), \`--radius-sm\` (6px) | Corners |
| \`--font-sans\`, \`--font-mono\` | The app's fonts; the page starts in sans at 14px / 1.6 |

- The default theme is monochrome: \`--primary\` is near-white in dark mode. Colour carries meaning:
  status colours for state, the chart colours for categories. Assign chart colours in order and keep
  each category on its colour throughout the page.
- Surfaces are translucent glass; don't stack many of them.
- \`<html>\` carries \`data-theme="dark"\` or \`"light"\` for the rare rule one mode needs.
  \`prefers-color-scheme\` does not follow the app; the variables and \`data-theme\` do.

## Scripts and libraries

Inline scripts run, and scripts, styles, fonts and images load over https, so chart and diagram
libraries work from a CDN. Pin the major version, for example:

- Chart.js: \`https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js\`
- D3: \`https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js\`
- ECharts: \`https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js\`
- Mermaid: \`https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js\`

Reach for a library when a chart needs real axes, many points or interaction; HTML, CSS and inline SVG
draw simple bars, timelines and diagrams with less weight.

Canvas and chart libraries can't read CSS variables, so the page gets \`window.cerium\`:

- \`cerium.color("--chart-1")\` gives a variable's colour resolved, for a library's options.
- \`cerium.mode\` is \`"dark"\` or \`"light"\`.
- \`cerium.onThemeChange(() => …)\` runs after the user switches theme: update the chart's colours
  there (Chart.js: set them again and call \`chart.update()\`).

The page runs sandboxed, in its own origin:

- Nothing over plain http, and nothing on this machine: no \`localhost\`, no local file paths. Images
  are https URLs or \`data:\` URLs; inline small SVGs.
- \`localStorage\`, cookies, \`alert\` and popups are unavailable. Forms don't submit; handle them in script.
- Links open in the user's browser.

Interaction earns its place: tabs over long sections, toggles between views, hover tooltips with exact
values, sortable tables, a slider for a what-if. Keep animation brief and honour
\`prefers-reduced-motion\`.

## Preview before you reply

Call \`artifact_preview\` (Cerium's MCP server) with the page's HTML. It renders it as the reader will,
at the column's width in the theme you ask for, and returns a screenshot, the page's height and its
console output, errors included. Fix what you see, then put the same HTML in your reply. Check light
mode when colours matter, and a width of about 380 when the layout is dense.

## Craft

- One idea per page, with a clear hierarchy: a short heading (\`h2\`-sized, 15–17px, weight 600) only
  when the page needs one, then the content. Prose belongs in your reply.
- Align to a grid and space generously and consistently (multiples of 4px). Restraint reads as
  quality: no gradients, glows or emoji for decoration; at most one accent.
- Numbers: \`font-variant-numeric: tabular-nums\`, units in muted text, exact values in tooltips or
  \`title\` attributes. Label marks directly; add a legend when two or more colours encode categories.
- Make it robust: no overflow at 360px, long labels truncate with an ellipsis or wrap, empty states
  are handled.

## Example

\`\`\`html
<style>
  .board { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
  .item { padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius); }
  .item h3 { margin: 0 0 4px; font-size: 13.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .item p { margin: 0; color: var(--muted-foreground); font-size: 13px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; }
  .chart { height: 180px; margin-top: 16px; }
</style>
<div class="board">
  <div class="item"><h3><span class="dot" style="background: var(--success)"></span>Parser</h3><p>Fixed; 14 tests pass.</p></div>
  <div class="item"><h3><span class="dot" style="background: var(--warning)"></span>Docs</h3><p>Waiting on your review.</p></div>
</div>
<div class="chart"><canvas id="runs"></canvas></div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script>
  const style = () => ({ color: cerium.color("--muted-foreground"), grid: cerium.color("--border"), bar: cerium.color("--chart-1") });
  let s = style();
  Chart.defaults.font.family = getComputedStyle(document.documentElement).getPropertyValue("--font-sans");
  const chart = new Chart(document.getElementById("runs"), {
    type: "bar",
    data: { labels: ["Mon", "Tue", "Wed", "Thu", "Fri"], datasets: [{ data: [12, 7, 15, 9, 18], backgroundColor: s.bar, borderRadius: 4 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: s.color }, grid: { display: false } }, y: { ticks: { color: s.color }, grid: { color: s.grid } } } },
  });
  cerium.onThemeChange(() => {
    s = style();
    chart.data.datasets[0].backgroundColor = s.bar;
    chart.options.scales.x.ticks.color = chart.options.scales.y.ticks.color = s.color;
    chart.options.scales.y.grid.color = s.grid;
    chart.update();
  });
</script>
\`\`\`
`;
