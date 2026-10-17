// What agents read, through the bus's `artifact_guide` tool, before writing an artifact. Every class
// and token it names must exist in `artifact.css`; the package's test checks that.

export const artifactGuide = `# Cerium artifacts

An artifact is a small HTML visual inside your reply. Cerium renders it inline, between your
paragraphs, with a stylesheet of building blocks already loaded. Use one when structure carries the
point: a timeline, a before/after, a pipeline, a comparison, metrics, a status board. Keep plain
lists and small tables in markdown.

## Format

Write a fenced code block with the language \`artifact\` holding an HTML fragment:

\`\`\`\`
\`\`\`artifact
<h2>What changed</h2>
<p>…</p>
\`\`\`
\`\`\`\`

- A fragment only: no \`<html>\`, \`<head>\` or \`<body>\`. It renders the full width of the
  conversation (about 720px, down to 400px) and grows to fit its content.
- Compose the building blocks below. A short \`<style>\` block or \`style\` attribute for something
  bespoke is fine, written with the tokens. Never write colours as hex, rgb or names.
- No scripts, external images, fonts or stylesheets (all blocked), no forms; links do not navigate.
  Inline \`<svg>\` and \`data:\` images work. In SVG set colours with \`style="fill: var(--series-1)"\`.
- Text always uses the text tokens. Colour belongs to marks (bars, pills, swatches, cards).
- Label marks directly and put exact values in a \`title\` attribute, which shows on hover.
- Keep the prose that explains the visual in markdown around the artifact, not inside it.

## Tokens

| Token | Use |
| --- | --- |
| \`--text\`, \`--text-2\`, \`--text-3\` | Primary, secondary and muted text |
| \`--border\`, \`--border-strong\` | Hairlines and emphasised edges |
| \`--fill\`, \`--fill-2\` | Subtle and stronger neutral fills |
| \`--info\`, \`--good\`, \`--warn\`, \`--bad\` | Status colours: in progress or planned, success, needs attention, failure |
| \`--series-1\` … \`--series-8\` | Categorical colours for identities (models, providers, files) |
| \`--font\`, \`--mono\` | Sans and monospace families |
| \`--radius\`, \`--radius-sm\` | Corner radii |

## Tones

Add a tone class to a mark to colour it: \`info\`, \`good\`, \`warn\`, \`bad\` for state; \`s1\` … \`s8\`
for categories. Status tones mean state only and never stand for a category. Assign series in order
(s1, s2, s3 …) and keep each category on the same series everywhere. With more than four series,
fold the rest into "Other". A tone never inherits: toning a card leaves its contents alone.

## Building blocks

Text: \`h2\` sections, \`h3\` sub-headings, \`p\`, \`ul\`/\`ol\`, \`code\`, \`strong\`. Classes \`muted\`,
\`note\` (small muted print), \`mono\`, \`num\` (aligned digits).

**Cards and grid.** A grid of equal columns that wraps on narrow widths. Set \`style="--cols: 3"\` to
fix the column count.

\`\`\`html
<div class="grid">
  <div class="card"><h3>Still open</h3><p>…</p></div>
  <div class="card warn"><h3>Needs you</h3><p>…</p></div>
</div>
\`\`\`

**Tabs.** Each \`section\` becomes a tab named by \`data-tab\`. Add \`numbered\` to number them.

\`\`\`html
<div class="tabs numbered">
  <section data-tab="Window past the end">…</section>
  <section data-tab="HTTP 416">…</section>
</div>
\`\`\`

**Pills and flows.** A pill is a label; a flow chains pills with arrows. Stack flows to compare.

\`\`\`html
<div class="flow"><span class="label">Before</span><span class="pill">download</span><span class="pill bad">check fails</span><span class="pill bad">clip missing</span></div>
<div class="flow"><span class="label">Now</span><span class="pill">download</span><span class="pill good">check passes</span></div>
\`\`\`

**Steps.** A pipeline of boxes in one row: a monospace title, then optional muted detail lines.
Keep it to five boxes with short lines.

\`\`\`html
<div class="steps">
  <div class="step"><span>branch host-ventana</span><span>from 0f0e1e74</span></div>
  <div class="step good"><span>image 7a9038f4</span><span>GitHub Actions build</span></div>
</div>
\`\`\`

**Ranges.** Spans on one shared scale: timelines, windows, overlaps. \`--max\` (and optional \`--min\`)
on the container sets the scale; each \`bar\` spans \`--from\` (default \`--min\`) to \`--to\` and may hold
a short label. A track can hold several bars. \`hatch\` stripes a bar (overflow, projected, missing);
a \`marker\` is a thin line at \`--at\` (add \`dashed\`). The \`axis\` places tick labels at \`--at\`.

\`\`\`html
<div class="ranges" style="--max: 180">
  <div class="row"><span class="label">Video file</span><div class="track"><span class="bar" style="--to: 143">143 s</span></div></div>
  <div class="row"><span class="label">Cutter asks for</span><div class="track">
    <span class="bar info" style="--to: 143">0–174 s</span>
    <span class="bar bad hatch" style="--from: 143; --to: 174" title="31 s past the end"></span>
  </div></div>
  <div class="row"><span class="label">New check</span><div class="track">
    <span class="bar good" style="--to: 141.5">download kept</span><span class="marker good" style="--at: 141.5"></span>
  </div></div>
  <div class="axis"><span style="--at: 0">0 s</span><span style="--at: 60">60</span><span style="--at: 120">120</span><span style="--at: 180">180 s</span></div>
</div>
\`\`\`

**Bars.** Horizontal magnitudes with a label and a value per row; same \`--max\` and \`--to\`. Bars
default to \`--series-1\`; tone a bar to highlight it.

\`\`\`html
<div class="bars" style="--max: 40">
  <div class="row"><span class="label">auth.spec.ts</span><div class="track"><span class="bar" style="--to: 31"></span></div><span class="value">31 s</span></div>
  <div class="row"><span class="label">db.spec.ts</span><div class="track"><span class="bar" style="--to: 12"></span></div><span class="value">12 s</span></div>
</div>
\`\`\`

**Columns.** Vertical bars over ordered categories such as days. \`--max\` on the container, \`--value\`
per column, optional \`--height\` (default 150px). Use \`hatch\` for estimates.

\`\`\`html
<div class="columns" style="--max: 20">
  <div class="col" style="--value: 12" title="Mon: 12 runs"><span class="value">12</span><span class="label">Mon</span></div>
  <div class="col hatch" style="--value: 7" title="Tue: 7 runs (estimate)"><span class="value">7</span><span class="label">Tue</span></div>
</div>
\`\`\`

**Legend.** Required whenever a visual uses two or more series.

\`\`\`html
<div class="legend"><span class="s1">Claude</span><span class="s2">Codex</span></div>
\`\`\`

**Stats.** Headline numbers. A \`delta\` takes a tone.

\`\`\`html
<div class="stats">
  <div class="stat"><span class="label">Clips recovered</span><span class="value">5 of 8</span><span class="delta good">+3 since the fix</span></div>
</div>
\`\`\`

**Meter.** Progress or share: \`--value\` out of \`--max\` (default 100).

\`\`\`html
<div class="meter good" style="--value: 62" title="62%"></div>
\`\`\`

**Definitions.** A \`dl\` lays terms out beside their descriptions; wrap identifiers in \`code\`.

\`\`\`html
<dl>
  <dt><code>f39dd456</code></dt><dd>Clip cutter uses the IP chain.</dd>
  <dt><code>2da27a8d</code></dt><dd>Download cap grows with the clip.</dd>
</dl>
\`\`\`

**Tables and disclosure.** \`table\` is styled; give numeric cells \`class="num"\`. \`details\` with a
\`summary\` hides secondary material.
`;
