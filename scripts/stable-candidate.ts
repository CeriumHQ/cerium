// Prepares and promotes private stable release drafts. The normal stable planner owns the
// commit and version. Speculative packages stay in place on GitHub when the draft is published.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, createReadStream, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { englishArtifact } from "../apps/desktop/src/chromiumLocales.ts";
import { mergeUpdateFiles } from "./merge-update-files.ts";

const PREFIX = "cerium-stable-candidate-";
const MARKER = "cerium stable candidate v2";
const BOT = "github-actions[bot]";
const DEPLOY_ARCHIVE = "candidate-deploy.tar.gz";
const CANDIDATE_WORKFLOW = ".github/workflows/stable-candidate.yml";
const HOUR = 3_600_000;
const MAX_AGE = 36 * HOUR;
const CLEANUP_AGE = 72 * HOUR;
const env = (name: string) => process.env[name] ?? "";
const output = (name: string, value: string) => appendFileSync(env("GITHUB_OUTPUT"), `${name}=${value}\n`);
const repo = () => `repos/${env("GITHUB_REPOSITORY")}`;
const temp = (name: string) => join(env("RUNNER_TEMP"), name);

interface Run {
  id: number;
  path: string;
  event: string;
  head_branch: string;
  head_sha: string;
  run_number: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  repository: { id: number };
  head_repository: { id: number } | null;
}

interface Job {
  name: string;
  conclusion: string;
  steps?: Array<{ name: string; conclusion: string }>;
}

interface FileDigest {
  name: string;
  size: number;
  digest: string;
}

interface Asset extends FileDigest {
  id: number;
  state: string;
  uploader: { login: string };
}

interface Release {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  body: string;
  author: { login: string };
  assets: Asset[];
}

interface Draft {
  marker: typeof MARKER;
  created: number;
  tag: string;
  commit: string;
  version: string;
}

interface Manifest extends Draft {
  config: string;
  assets: Array<FileDigest & { id: number }>;
}

interface PackageRecord {
  files: FileDigest[];
  update: string;
  config: string;
}

function requireCandidate(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function api<T>(endpoint: string, method = "GET", body?: object): T {
  const args = ["api", "--method", method, endpoint];
  if (body !== undefined) args.push("--input", "-");
  const response = execFileSync("gh", args, {
    input: body === undefined ? "" : JSON.stringify(body),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 12_000,
  });
  return (response === "" ? undefined : JSON.parse(response)) as T;
}

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 12_000 }).trim();
const version = () => env("VERSION");
const commit = () => env("COMMIT");
const candidate = () => env("CANDIDATE");
const candidateTag = (id: number | string) => `${PREFIX}${id}`;
const isCandidateTag = (tag: string) => /^cerium-stable-candidate-[1-9]\d*$/.test(tag);
const sealName = () => `Seal candidate ${version()} from ${commit()}`;
const getRelease = (id: number) => api<Release>(`${repo()}/releases/${id}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const manifestDigest = (body: string) => createHash("sha256").update(body).digest("hex");

const platforms = ["Linux-X64", "Linux-ARM64", "Windows-X64", "Windows-ARM64", "macOS-X64", "macOS-ARM64"];
const localeVariants = ["full", "english"] as const;
type LocaleVariant = (typeof localeVariants)[number];
const builds = platforms.flatMap((platform) => localeVariants.map((locale) => ({ platform, locale })));
const recordName = (build: string) => `candidate-${build}.json`;
const webTar = () => `cerium-web-${version()}.tar.gz`;

function fullPackageNames(platform: string) {
  const arm = platform.endsWith("-ARM64");
  const arch = arm ? "arm64" : "x64";
  const label = `Cerium-${version()}`;
  if (platform.startsWith("Windows-")) {
    const installer = `Cerium-Setup-${version()}-${arch}.exe`;
    return { files: [installer, `${installer}.blockmap`], update: "latest.yml" };
  }
  if (platform.startsWith("macOS-")) {
    const zip = `${label}-${arch}-mac.zip`;
    return { files: [`${label}-${arch}.dmg`, zip, `${zip}.blockmap`], update: "latest-mac.yml" };
  }
  return {
    files: [
      `${label}-${arm ? "arm64" : "x86_64"}.AppImage`,
      `cerium_${version()}_${arm ? "arm64" : "amd64"}.deb`,
      `cerium-${version()}.${arm ? "aarch64" : "x86_64"}.rpm`,
    ],
    update: arm ? "latest-linux-arm64.yml" : "latest-linux.yml",
  };
}

function packageNames(platform: string, locale: LocaleVariant) {
  const { files, update } = fullPackageNames(platform);
  if (locale === "english") return { files: files.map(englishArtifact), update };
  if (platform === "Windows-X64") files.push(`cerium-dictation-${version()}.wasm`);
  return { files, update };
}

function config() {
  return manifestDigest(JSON.stringify([MARKER, "ad hoc", env("SENTRY_DSN")]));
}

function adHoc() {
  if (env("SIGNING_CONFIGURED") === "false") return true;
  console.log("Apple signing is configured or unknown. Use the native stable build.");
  return false;
}

const publicNames = () =>
  new Set([
    ...builds.flatMap(({ platform, locale }) => {
      const { files, update } = packageNames(platform, locale);
      return [...files, update];
    }),
    webTar(),
  ]);

async function digest(path: string, name: string): Promise<FileDigest> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  requireCandidate(size > 0, `Empty candidate file ${name}.`);
  return { name, size, digest: `sha256:${hash.digest("hex")}` };
}

const fileDigest = ({ name, size, digest }: FileDigest): FileDigest => ({ name, size, digest });
const snapshot = (asset: Asset) => ({ ...fileDigest(asset), id: asset.id });

function assets(release: Release, names: Set<string>): Asset[] {
  const byName = new Set(release.assets.map((asset) => asset.name));
  requireCandidate(
    byName.size === release.assets.length &&
      byName.size === names.size &&
      [...names].every((name) => byName.has(name)) &&
      release.assets.every(
        (asset) =>
          asset.state === "uploaded" &&
          asset.uploader?.login === BOT &&
          asset.size > 0 &&
          /^sha256:[a-f0-9]{64}$/.test(asset.digest),
      ),
    "The draft's asset set, upload status, or provenance is invalid.",
  );
  return release.assets.toSorted((a, b) => a.name.localeCompare(b.name));
}

function draftOf(release: Release): Draft {
  requireCandidate(
    release.draft &&
      release.prerelease &&
      release.published_at === null &&
      release.author?.login === BOT &&
      isCandidateTag(release.tag_name),
    "The release is not a private candidate draft.",
  );
  const draft = JSON.parse(release.body) as Draft;
  requireCandidate(
    draft.marker === MARKER &&
      draft.tag === release.tag_name &&
      (release.target_commitish === "main" || release.target_commitish === draft.commit) &&
      /^[a-f0-9]{40}$/.test(draft.commit) &&
      /^\d+\.\d+\.\d+$/.test(draft.version) &&
      Number.isSafeInteger(draft.created) &&
      draft.created > 0 &&
      draft.created <= Date.now(),
    "The draft's metadata is invalid.",
  );
  return draft;
}

function exactDraft(release: Release): Draft {
  const draft = draftOf(release);
  requireCandidate(
    draft.tag === candidate() &&
      draft.commit === commit() &&
      draft.version === version() &&
      Date.now() - draft.created < MAX_AGE,
    "The draft is stale or belongs to a different stable plan.",
  );
  return draft;
}

async function download(asset: Asset, path: string) {
  const fd = openSync(path, "wx");
  try {
    execFileSync(
      "gh",
      ["api", `${repo()}/releases/assets/${asset.id}`, "-H", "Accept: application/octet-stream"],
      {
        stdio: ["ignore", fd, "pipe"],
        timeout: 60_000,
      },
    );
  } finally {
    closeSync(fd);
  }
  requireCandidate(
    same(await digest(path, asset.name), fileDigest(asset)),
    `The download of ${asset.name} failed verification.`,
  );
}

function upload(paths: string[]) {
  requireCandidate(
    env("GITHUB_RUN_ATTEMPT") === "1" && candidate() === candidateTag(env("GITHUB_RUN_ID")),
    "Only the original preparation run may upload candidate files.",
  );
  execFileSync("gh", ["release", "upload", candidate(), ...paths, "--repo", env("GITHUB_REPOSITORY")], {
    stdio: "inherit",
    timeout: 240_000,
  });
}

function trustedRun(run: Run, path: string, event: string) {
  const id = Number(env("GITHUB_REPOSITORY_ID"));
  return (
    run.path.split("@")[0] === path &&
    run.event === event &&
    run.head_branch === "main" &&
    run.repository.id === id &&
    run.head_repository?.id === id
  );
}

const jobs = (run: Run) =>
  api<{ jobs: Job[] }>(`${repo()}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`).jobs;
const runs = (workflow: string, query: string) =>
  api<{ workflow_runs: Run[] }>(`${repo()}/actions/workflows/${workflow}/runs?branch=main&${query}`)
    .workflow_runs;

function sameFiles(from: string, to: string, files: string[]) {
  return git("diff", "--name-only", from, to, "--", ...files) === "";
}

function prepare() {
  if (!adHoc()) return;
  const head = env("GITHUB_SHA");
  // The push run's creation time measures when main last moved, even for backdated commits.
  const [lastPush] = runs("ci.yml", "event=push&per_page=1");
  if (
    lastPush === undefined ||
    !trustedRun(lastPush, ".github/workflows/ci.yml", "push") ||
    lastPush.head_sha !== head ||
    !(Date.now() - Date.parse(lastPush.created_at) >= 2 * HOUR) ||
    git("ls-remote", "origin", "refs/heads/main").split(/\s+/)[0] !== head
  ) {
    console.log("Main has not been quiet for two hours.");
    return;
  }
  if (
    !sameFiles(commit(), head, [
      ".github/actions/package",
      ".github/actions/web",
      "scripts/stable-candidate.ts",
    ])
  ) {
    console.log("The planned commit uses an earlier candidate build recipe.");
    return;
  }

  const tags = git("tag", "--points-at", commit(), "--list", "v*-nightly.*").split("\n");
  const ci = runs("ci.yml", `event=push&head_sha=${commit()}&per_page=20`);
  const published = ci.some((run) => {
    if (!trustedRun(run, ".github/workflows/ci.yml", "push") || run.head_sha !== commit()) return false;
    const tag = tags.find((tag) => {
      const match = /^v\d+\.\d+\.\d+-nightly\.n?(\d+)$/.exec(tag);
      return match !== null && Number(match[1]) === run.run_number;
    });
    if (
      tag === undefined ||
      !jobs(run).some(
        (job) =>
          job.name === "Publish the nightly" &&
          job.conclusion === "success" &&
          job.steps?.some((step) => step.name === "Publish the nightly" && step.conclusion === "success"),
      )
    )
      return false;
    const nightly = api<Release>(`${repo()}/releases/tags/${tag}`);
    return (
      !nightly.draft &&
      nightly.prerelease &&
      nightly.published_at !== null &&
      nightly.tag_name === tag &&
      nightly.target_commitish === commit() &&
      nightly.author?.login === BOT
    );
  });
  if (!published) {
    console.log("No trusted nightly publisher has completed for this commit.");
    return;
  }

  const tag = candidateTag(env("GITHUB_RUN_ID"));
  const draft: Draft = { marker: MARKER, created: Date.now(), tag, commit: commit(), version: version() };
  const release = api<Release>(`${repo()}/releases`, "POST", {
    tag_name: tag,
    // The draft has no Git tag. Its manifest records the packaged commit until promotion tags it.
    target_commitish: "main",
    draft: true,
    prerelease: true,
    name: `Stable candidate ${version()}`,
    body: JSON.stringify(draft),
  });
  requireCandidate(same(draftOf(release), draft), "GitHub did not create the expected private draft.");
  output("draft", tag);
  output("release-id", String(release.id));
}

function find() {
  if (!adHoc()) return;
  const cutoff = encodeURIComponent(`>=${new Date(Date.now() - MAX_AGE).toISOString()}`);
  const completed = runs(
    "stable-candidate.yml",
    `event=schedule&status=success&created=${cutoff}&per_page=5`,
  );
  for (const run of completed) {
    if (
      !trustedRun(run, CANDIDATE_WORKFLOW, "schedule") ||
      run.run_attempt !== 1 ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      !(Date.now() - Date.parse(run.created_at) < MAX_AGE) ||
      !sameFiles(run.head_sha, env("GITHUB_SHA"), [
        CANDIDATE_WORKFLOW,
        ".github/workflows/stable-build.yml",
        "scripts/stable-candidate.ts",
      ]) ||
      !sameFiles(commit(), env("GITHUB_SHA"), ["scripts/stable-candidate.ts"])
    )
      continue;
    const successful = jobs(run).filter((job) => job.conclusion === "success");
    if (!successful.some((job) => job.name === sealName())) continue;
    const attestations = successful.flatMap((job) => {
      const match = /^Manifest ([1-9]\d*) ([a-f0-9]{64})$/.exec(job.name);
      return match === null ? [] : [{ id: match[1]!, digest: match[2]! }];
    });
    if (attestations.length !== 1) continue;
    output("candidate", candidateTag(run.id));
    output("release-id", attestations[0]!.id);
    output("digest", attestations[0]!.digest);
    return;
  }
  console.log("No completed candidate matches the stable plan.");
}

async function uploadPackage() {
  const platform = `${env("RUNNER_OS")}-${env("RUNNER_ARCH")}`;
  requireCandidate(platforms.includes(platform), "Unexpected candidate runner.");
  const locale = env("CHROMIUM_LOCALES");
  requireCandidate(locale === "full" || locale === "english", "Unexpected candidate Chromium locales.");
  const { files, update } = packageNames(platform, locale);
  const out = "apps/desktop/out";
  const record: PackageRecord = {
    files: await Promise.all(files.map((name) => digest(join(out, name), name))),
    update: readFileSync(join(out, update), "utf8"),
    config: config(),
  };
  requireCandidate(
    record.update.split(/\r?\n/).includes(`version: ${version()}`),
    "The package update file names another version.",
  );
  const recordFile = temp(recordName(`${platform}-${locale}`));
  writeFileSync(recordFile, JSON.stringify(record));
  upload([...files.map((file) => join(out, file)), recordFile]);
}

async function uploadWeb() {
  const archive = temp(DEPLOY_ARCHIVE);
  execFileSync("tar", ["-czf", archive, "-C", "apps", "ui/dist-web", "site/dist"]);
  const webFile = join("apps/relay/dist", webTar());
  const files = await Promise.all([digest(archive, DEPLOY_ARCHIVE), digest(webFile, webTar())]);
  const record = temp(recordName("web"));
  writeFileSync(record, JSON.stringify(files));
  upload([archive, webFile, record]);
}

async function seal() {
  const id = Number(env("RELEASE_ID"));
  const release = getRelease(id);
  const draft = exactDraft(release);
  const recordBuilds = builds.map(({ platform, locale }) => `${platform}-${locale}`);
  const recordKeys = [...recordBuilds, "web"];
  const initialNames = new Set([
    ...builds.flatMap(({ platform, locale }) => packageNames(platform, locale).files),
    webTar(),
    DEPLOY_ARCHIVE,
    ...recordKeys.map(recordName),
  ]);
  const initial = new Map(assets(release, initialNames).map((asset) => [asset.name, asset]));
  const readRecord = async <T>(platform: string): Promise<T> => {
    const name = recordName(platform);
    const path = temp(name);
    await download(initial.get(name)!, path);
    return JSON.parse(readFileSync(path, "utf8")) as T;
  };
  const checkFiles = (files: FileDigest[], names: string[]) =>
    requireCandidate(
      same(
        files,
        names.map((name) => fileDigest(initial.get(name)!)),
      ),
      "An uploaded asset does not match the builder's digest.",
    );
  const records = await Promise.all(recordBuilds.map((key) => readRecord<PackageRecord>(key)));
  const configuration = records[0]!.config;
  requireCandidate(
    /^[a-f0-9]{64}$/.test(configuration) && records.every((record) => record.config === configuration),
    "The candidate packages were built with different settings.",
  );
  const updates = new Map<string, string[]>();
  for (const [index, { platform, locale }] of builds.entries()) {
    const { files, update } = packageNames(platform, locale);
    const record = records[index]!;
    checkFiles(record.files, files);
    const texts = updates.get(update) ?? [];
    texts.push(record.update);
    updates.set(update, texts);
  }
  checkFiles(await readRecord<FileDigest[]>("web"), [DEPLOY_ARCHIVE, webTar()]);

  const merged = new Map<string, FileDigest>();
  for (const [name, texts] of updates) {
    const path = temp(name);
    writeFileSync(path, texts.length === 1 ? texts[0]! : mergeUpdateFiles(texts));
    merged.set(name, await digest(path, name));
  }
  upload([...updates.keys()].map(temp));
  for (const key of recordKeys)
    api(`${repo()}/releases/assets/${initial.get(recordName(key))!.id}`, "DELETE");

  const sealed = getRelease(id);
  exactDraft(sealed);
  const final = assets(sealed, new Set([...publicNames(), DEPLOY_ARCHIVE]));
  for (const asset of final) {
    const expected = merged.get(asset.name) ?? initial.get(asset.name)!;
    requireCandidate(
      same(fileDigest(asset), fileDigest(expected)),
      "An asset changed while sealing the draft.",
    );
  }
  const manifest: Manifest = {
    ...draft,
    config: configuration,
    assets: final.map(snapshot),
  };
  const body = JSON.stringify(manifest);
  const saved = api<Release>(`${repo()}/releases/${id}`, "PATCH", {
    tag_name: draft.tag,
    target_commitish: draft.commit,
    body,
  });
  exactDraft(saved);
  requireCandidate(saved.body === body, "GitHub did not store the expected candidate manifest.");
  output("digest", manifestDigest(body));
}

const staged = () => JSON.parse(readFileSync(temp("verified-candidate.json"), "utf8")) as Release;
const publicAssets = (release: Release) => assets(release, publicNames()).map(snapshot);
const manifestOf = (release: Release) => JSON.parse(release.body) as Manifest;

async function stage() {
  requireCandidate(adHoc(), "A signed stable build cannot use an ad hoc candidate.");
  const id = Number(env("RELEASE_ID"));
  requireCandidate(Number.isSafeInteger(id) && id > 0, "The candidate release ID is invalid.");
  const release = getRelease(id);
  requireCandidate(release.id === id, "GitHub did not return the attested draft.");
  exactDraft(release);
  requireCandidate(
    manifestDigest(release.body) === env("CANDIDATE_DIGEST"),
    "The draft manifest does not match the successful preparation run.",
  );
  const manifest = manifestOf(release);
  requireCandidate(manifest.config === config(), "The candidate's build configuration changed.");
  const current = assets(release, new Set([...publicNames(), DEPLOY_ARCHIVE]));
  requireCandidate(same(current.map(snapshot), manifest.assets), "The candidate's sealed assets changed.");
  const archive = temp(DEPLOY_ARCHIVE);
  await download(
    current.find((asset) => asset.name === DEPLOY_ARCHIVE)!,
    archive,
  );
  execFileSync("tar", ["-xzf", archive, "--no-same-owner", "-C", "apps"]);
  const build = JSON.parse(readFileSync("apps/ui/dist-web/build.json", "utf8")) as { version: string };
  requireCandidate(build.version === version(), "The candidate contains another web version.");
  readFileSync("apps/site/dist/index.html");
  writeFileSync(temp("verified-candidate.json"), JSON.stringify(release));
}

function checkStaged(release: Release, expected: Release) {
  exactDraft(release);
  requireCandidate(release.body === expected.body, "The candidate manifest changed after verification.");
}

function reserve() {
  const expected = staged();
  const release = getRelease(expected.id);
  checkStaged(release, expected);
  const current = assets(release, new Set([...publicNames(), DEPLOY_ARCHIVE]));
  requireCandidate(
    same(current.map(snapshot), manifestOf(expected).assets),
    "The candidate's assets changed before deployment.",
  );
  requireCandidate(
    git("ls-remote", "origin", `refs/tags/v${version()}`) === "",
    "The stable tag already exists.",
  );
  api(`${repo()}/releases/assets/${current.find((asset) => asset.name === DEPLOY_ARCHIVE)!.id}`, "DELETE");
  checkReserved(expected);
}

function checkReserved(expected: Release) {
  const release = getRelease(expected.id);
  checkStaged(release, expected);
  const expectedPublic = manifestOf(expected).assets.filter((asset) => asset.name !== DEPLOY_ARCHIVE);
  requireCandidate(same(publicAssets(release), expectedPublic), "The candidate's public assets changed.");
}

function publish() {
  const expected = staged();
  checkReserved(expected);
  const tag = env("TAG");
  const ref = `refs/tags/${tag}`;
  const refs = new Map(
    git("ls-remote", "origin", ref, `${ref}^{}`)
      .split("\n")
      .map((line) => {
        const [sha, name] = line.split("\t");
        return [name, sha];
      }),
  );
  requireCandidate(
    tag === `v${version()}` && (refs.get(`${ref}^{}`) ?? refs.get(ref)) === commit(),
    "The stable tag does not point to the packaged commit.",
  );
  const release = api<Release>(`${repo()}/releases/${expected.id}`, "PATCH", {
    tag_name: tag,
    draft: false,
    prerelease: false,
    make_latest: "true",
    name: env("TITLE"),
    body: readFileSync(temp("notes.md"), "utf8"),
  });
  requireCandidate(
    !release.draft && !release.prerelease && release.tag_name === tag,
    "GitHub did not publish the expected stable release.",
  );
}

function prune() {
  // Paginate and project in gh so Node never buffers the repository's full release history.
  const drafts = execFileSync(
    "gh",
    [
      "api",
      "--paginate",
      `${repo()}/releases?per_page=50`,
      "--jq",
      '.[] | select(.draft and (.tag_name | test("^cerium-stable-candidate-[1-9][0-9]*$"))) | .id',
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
  );
  for (const line of drafts.trim().split(/\s+/).filter(Boolean)) {
    const id = Number(line);
    try {
      const current = getRelease(id);
      if (current.id === id && Date.now() - draftOf(current).created >= CLEANUP_AGE)
        api(`${repo()}/releases/${id}`, "DELETE");
    } catch {
      console.warn(`Could not prune candidate draft ${id}.`);
    }
  }
}

const commands = {
  prepare,
  find,
  "upload-package": uploadPackage,
  "upload-web": uploadWeb,
  seal,
  stage,
  reserve,
  publish,
  prune,
};
const command = process.argv[2] as keyof typeof commands;
try {
  requireCandidate(Object.hasOwn(commands, command), "Unknown stable candidate operation.");
  if (command !== "prune") {
    requireCandidate(
      /^[a-f0-9]{40}$/.test(commit()) || command.startsWith("upload-"),
      "Invalid candidate commit.",
    );
    requireCandidate(/^\d+\.\d+\.\d+$/.test(version()), "Invalid stable candidate version.");
    if (command !== "prepare" && command !== "find")
      requireCandidate(isCandidateTag(candidate()), "Invalid stable candidate tag.");
  }
  await commands[command]();
} catch (error) {
  // Subprocess failures may contain request arguments or response bodies in their details.
  console.error(
    error instanceof Error && !("status" in error) ? error.message : "A candidate command failed.",
  );
  process.exitCode = 1;
}
