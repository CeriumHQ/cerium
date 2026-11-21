// Run from the repository root with node scripts/test/stable-candidate.fixture.ts.
// Uses real Git, tar and the candidate CLI, with a local gh shim and tiny stand-ins for build output.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bot = { login: "github-actions[bot]" };
const hour = 3_600_000;
const tag = "cerium-stable-candidate-502";
const version = "1.2.3";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fixture = fileURLToPath(import.meta.url);
const helper = fileURLToPath(new URL("../stable-candidate.ts", import.meta.url));

interface Asset {
  id: number;
  name: string;
  size: number;
  state: "uploaded";
  digest: string;
  uploader: typeof bot;
  content: string;
}

interface Release {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  author: typeof bot;
  body: string;
  assets: Asset[];
}

interface State {
  next: number;
  releases: Release[];
  head: string;
  quiet: boolean;
  nightly: boolean;
  ready: boolean;
  attestation: string;
}

function fakeGithub(args: string[]) {
  const store = process.env["CANDIDATE_FIXTURE_DB"]!;
  const state = JSON.parse(readFileSync(store, "utf8")) as State;
  const save = () => writeFileSync(store, JSON.stringify(state));
  const send = (value: unknown) => console.log(JSON.stringify(value));
  const visible = ({ assets, ...release }: Release) => ({
    ...release,
    assets: assets.map(({ id, name, size, digest, state, uploader }) => ({
      id,
      name,
      size,
      digest,
      state,
      uploader,
    })),
  });
  if (args[0] === "release") {
    const release = state.releases.find((item) => item.tag_name === args[2] && item.draft);
    assert.ok(release);
    for (const path of args.slice(3, args.indexOf("--repo"))) {
      const content = readFileSync(path);
      const name = basename(path);
      assert.ok(!release.assets.some((asset) => asset.name === name));
      release.assets.push({
        id: state.next++,
        name,
        size: content.length,
        state: "uploaded",
        digest: `sha256:${digest(content)}`,
        uploader: bot,
        content: content.toString("base64"),
      });
    }
    save();
    return;
  }

  assert.equal(args[0], "api");
  const endpoint = args
    .find((arg) => arg.startsWith("repos/fixture/cerium/"))!
    .replace("repos/fixture/cerium/", "");
  const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
  const run = (id: number, path: string, event: string, age: number) => ({
    id,
    path: `.github/workflows/${path}@refs/heads/main`,
    event,
    head_branch: "main",
    head_sha: state.head,
    run_number: 42,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    created_at: new Date(Date.now() - age).toISOString(),
    repository: { id: 99 },
    head_repository: { id: 99 },
  });
  if (endpoint.startsWith("actions/workflows/ci.yml/"))
    return send({ workflow_runs: [run(501, "ci.yml", "push", state.quiet ? 3 * hour : hour)] });
  if (endpoint.startsWith("actions/workflows/stable-candidate.yml/"))
    return send({ workflow_runs: [run(502, "stable-candidate.yml", "schedule", hour / 2)] });
  if (endpoint.startsWith("actions/runs/501/"))
    return send({
      jobs: [
        {
          name: "Publish the nightly",
          conclusion: "success",
          steps: [{ name: "Publish the nightly", conclusion: state.nightly ? "success" : "skipped" }],
        },
      ],
    });
  if (endpoint.startsWith("actions/runs/502/"))
    return send({
      jobs: [
        { name: `Seal candidate ${version} from ${state.head}`, conclusion: "success" },
        { name: `Manifest 100 ${state.attestation}`, conclusion: state.ready ? "success" : "failure" },
      ],
    });
  if (endpoint === "releases/tags/v1.2.3-nightly.n000042")
    return send({
      tag_name: "v1.2.3-nightly.n000042",
      target_commitish: state.head,
      draft: false,
      prerelease: true,
      published_at: new Date().toISOString(),
      author: bot,
    });
  if (endpoint === "releases?per_page=50") {
    assert.ok(args.includes("--paginate") && args.includes("--jq"));
    for (const release of state.releases) {
      if (release.draft && /^cerium-stable-candidate-[1-9]\d*$/.test(release.tag_name))
        console.log(release.id);
    }
    return;
  }
  if (endpoint === "releases" && method === "POST") {
    const input = JSON.parse(readFileSync(0, "utf8")) as Release;
    assert.equal(input.draft, true);
    assert.equal(input.prerelease, true);
    assert.equal(input.target_commitish, "main");
    const release = { ...input, id: 100, author: bot, published_at: null, assets: [] };
    state.releases.push(release);
    save();
    return send(visible(release));
  }
  const assetId = /^releases\/assets\/(\d+)$/.exec(endpoint);
  if (assetId !== null) {
    const release = state.releases.find((item) =>
      item.assets.some((asset) => asset.id === Number(assetId[1])),
    );
    assert.ok(release);
    const asset = release.assets.find((asset) => asset.id === Number(assetId[1]))!;
    if (method === "GET") {
      assert.ok(args.includes("Accept: application/octet-stream"));
      process.stdout.write(Buffer.from(asset.content, "base64"));
    } else {
      assert.equal(method, "DELETE");
      assert.ok(release.draft);
      release.assets = release.assets.filter((item) => item !== asset);
      save();
    }
    return;
  }
  const releaseId = /^releases\/(\d+)$/.exec(endpoint);
  assert.ok(releaseId, endpoint);
  const release = state.releases.find((item) => item.id === Number(releaseId[1]));
  assert.ok(release);
  if (method === "DELETE") {
    assert.ok(release.draft);
    state.releases = state.releases.filter((item) => item !== release);
    return save();
  }
  if (method === "PATCH") {
    const input = JSON.parse(readFileSync(0, "utf8")) as Partial<Release> & { make_latest?: string };
    assert.ok(input.tag_name, "Updating a GitHub draft must preserve or supply its tag.");
    if (input.draft === false) {
      assert.equal(input.tag_name, `v${version}`);
      assert.equal(input.make_latest, "true");
      assert.equal(input.target_commitish, undefined);
      assert.ok(!release.assets.some((asset) => asset.name.startsWith("candidate-")));
      release.published_at = new Date().toISOString();
    }
    Object.assign(release, input);
    save();
  }
  return send(visible(release));
}

function runFixture() {
  const workspace = mkdtempSync(join(tmpdir(), "cerium-candidate-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
  const file = (name: string, contents: string) => {
    const path = join(workspace, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    return path;
  };
  try {
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "feat: fixture",
    );
    const head = git("rev-parse", "HEAD");
    git("remote", "add", "origin", ".");
    git("tag", "v1.2.3-nightly.n000042");
    const stub = file(
      "bin/gh",
      '#!/bin/sh\nexec "$CANDIDATE_FIXTURE_NODE" "$CANDIDATE_FIXTURE_SCRIPT" gh "$@"\n',
    );
    execFileSync("chmod", ["+x", stub]);
    const store = join(workspace, "github.json");
    const output = join(workspace, "github-output");
    const runnerTemp = join(workspace, "runner-temp");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${dirname(stub)}:${process.env["PATH"]}`,
      GH_TOKEN: "",
      CANDIDATE_FIXTURE_NODE: process.execPath,
      CANDIDATE_FIXTURE_SCRIPT: fixture,
      CANDIDATE_FIXTURE_DB: store,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "fixture/cerium",
      GITHUB_REPOSITORY_ID: "99",
      GITHUB_RUN_ID: "502",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: head,
      COMMIT: head,
      VERSION: version,
      SIGNING_CONFIGURED: "false",
      SENTRY_DSN: "fixture",
      CANDIDATE: tag,
      RELEASE_ID: "100",
      RUNNER_TEMP: runnerTemp,
    };
    const load = () => JSON.parse(readFileSync(store, "utf8")) as State;
    const save = (state: State) => writeFileSync(store, JSON.stringify(state));
    const run = (command: string, extra: Record<string, string> = {}, expectedError?: RegExp) => {
      writeFileSync(output, "");
      rmSync(runnerTemp, { force: true, recursive: true });
      mkdirSync(runnerTemp);
      const result = spawnSync(process.execPath, [helper, command], {
        cwd: workspace,
        encoding: "utf8",
        env: { ...env, ...extra },
      });
      if (expectedError === undefined) assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      else {
        assert.equal(result.status, 1);
        assert.match(result.stderr, expectedError);
      }
      return readFileSync(output, "utf8");
    };

    save({ next: 1000, releases: [], head, quiet: false, nightly: false, ready: false, attestation: "" });
    assert.equal(run("prepare"), "");
    save({ ...load(), quiet: true });
    assert.equal(run("prepare"), "");
    save({ ...load(), nightly: true });
    assert.equal(run("prepare", { SIGNING_CONFIGURED: "true" }), "");
    assert.match(run("prepare"), new RegExp(`draft=${tag}\nrelease-id=100`));
    assert.equal(run("find"), "");
    console.log("Preparation requires two quiet hours, the successful nightly publisher, and ad hoc config.");

    const native = [
      ["Linux", "X64", "latest-linux.yml", [`Cerium-${version}-x86_64.AppImage`]],
      [
        "Windows",
        "X64",
        "latest.yml",
        [
          `Cerium-Setup-${version}-x64.exe`,
          `Cerium-Setup-${version}-x64.exe.blockmap`,
          `cerium-dictation-${version}.wasm`,
        ],
      ],
      [
        "macOS",
        "ARM64",
        "latest-mac.yml",
        [
          `Cerium-${version}-arm64-mac.zip`,
          `Cerium-${version}-arm64-mac.zip.blockmap`,
          `Cerium-${version}-arm64.dmg`,
        ],
      ],
    ] as const;
    for (const [os, arch, update, payload] of native) {
      for (const asset of payload) file(`apps/desktop/out/${asset}`, asset);
      file(
        `apps/desktop/out/${update}`,
        `version: ${version}\nfiles:\n  - url: ${payload[0]}\npath: ${payload[0]}\n`,
      );
      run("upload-package", { RUNNER_OS: os, RUNNER_ARCH: arch });
    }
    file("apps/ui/dist-web/build.json", JSON.stringify({ version }));
    file("apps/site/dist/index.html", "<h1>Cerium</h1>");
    file(`apps/relay/dist/cerium-web-${version}.tar.gz`, "fixture web release archive");
    run("upload-web");
    const sealed = /^digest=([a-f0-9]{64})\n$/.exec(run("seal"))?.[1];
    assert.ok(sealed);
    assert.equal(sealed, digest(load().releases[0]!.body));
    save({ ...load(), ready: true, attestation: sealed });
    assert.match(
      run("find"),
      /^candidate=cerium-stable-candidate-502\nrelease-id=100\ndigest=[a-f0-9]{64}\n$/,
    );
    assert.equal(run("find", { VERSION: "2.0.0" }), "");
    assert.equal(run("find", { COMMIT: "0".repeat(40) }, /candidate command failed/), "");
    assert.equal(run("find", { SIGNING_CONFIGURED: "true" }), "");
    env["CANDIDATE_DIGEST"] = sealed;
    const valid = load();
    const invalid = load();
    invalid.releases[0]!.body += " ";
    save(invalid);
    run("stage", {}, /successful preparation run/);
    const stale = structuredClone(valid);
    stale.releases[0]!.body = JSON.stringify({
      ...JSON.parse(stale.releases[0]!.body),
      created: Date.now() - 37 * hour,
    });
    save(stale);
    run("stage", {}, /draft is stale/);
    save({ ...valid, releases: [] });
    run("stage", {}, /candidate command failed/);
    const missing = load();
    missing.releases = [{ ...valid.releases[0]!, assets: valid.releases[0]!.assets.slice(1) }];
    save(missing);
    run("stage", {}, /asset set/);
    const corrupt = load();
    corrupt.releases = structuredClone(valid.releases);
    corrupt.releases[0]!.assets.find((asset) => asset.name === "candidate-deploy.tar.gz")!.content =
      Buffer.from("corrupt archive").toString("base64");
    save(corrupt);
    run("stage", {}, /download of candidate-deploy/);
    save(valid);
    run("stage", { SENTRY_DSN: "changed" }, /build configuration changed/);
    run("stage", { SIGNING_CONFIGURED: "true" }, /signed stable build/);
    console.log(
      "Exact lookup bypasses overrides and signing. Missing, modified, and corrupt drafts fail verification.",
    );

    run("stage");
    const staged = readFileSync(join(runnerTemp, "verified-candidate.json"), "utf8");
    // These commands share one runner in production.
    const continuePromotion = (command: string) => {
      execFileSync(process.execPath, [helper, command], {
        cwd: workspace,
        env: { ...env, TAG: `v${version}`, TITLE: "Cerium 1.2.3" },
        stdio: "pipe",
      });
    };
    assert.ok(staged);
    const disappeared = structuredClone(valid);
    disappeared.releases[0]!.assets.pop();
    save(disappeared);
    assert.throws(() => continuePromotion("reserve"), /asset set/);
    save(valid);
    continuePromotion("reserve");
    assert.equal(load().releases[0]!.draft, true);
    assert.ok(!load().releases[0]!.assets.some((asset) => asset.name.startsWith("candidate-")));
    file("runner-temp/notes.md", "The current release notes.\n");
    assert.throws(() => continuePromotion("publish"), /stable tag does not point to the packaged commit/);
    git("tag", `v${version}`, git("rev-parse", "HEAD^{tree}"));
    assert.throws(() => continuePromotion("publish"), /stable tag does not point to the packaged commit/);
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "tag",
      "-af",
      `v${version}`,
      "-m",
      "Stable",
    );
    continuePromotion("publish");
    const published = load().releases[0]!;
    assert.equal(published.draft, false);
    assert.equal(published.tag_name, `v${version}`);
    assert.equal(published.body, "The current release notes.\n");
    assert.equal(published.assets.length, 11);
    const publicAssets = new Map(published.assets.map((asset) => [asset.name, asset]));
    assert.ok(publicAssets.has(`cerium-dictation-${version}.wasm`));
    for (const [, , update, files] of native) {
      for (const file of files) assert.ok(publicAssets.has(file));
      const metadata = publicAssets.get(update);
      assert.ok(metadata);
      assert.ok(Buffer.from(metadata.content, "base64").toString("utf8").includes(files[0]));
    }
    console.log(
      "Promotion preserves public assets, removes the private deploy bundle, and publishes fresh notes.",
    );

    const [draft] = valid.releases;
    assert.ok(draft);
    const expired = (id: number, tag_name: string, age: number, author = bot) => ({
      ...draft,
      id,
      tag_name,
      author,
      body: JSON.stringify({
        ...JSON.parse(draft.body),
        tag: tag_name,
        created: Date.now() - age,
      }),
    });
    save({
      ...load(),
      releases: [
        published,
        expired(101, "cerium-stable-candidate-601", 73 * hour),
        expired(102, "cerium-stable-candidate-602", 25 * hour),
        expired(103, "v1.2.3-nightly.n000001", 90 * hour),
        expired(104, "cerium-stable-candidate-604", 90 * hour, { login: "maintainer" }),
      ],
    });
    run("prune");
    assert.deepEqual(
      load().releases.map((release) => release.id),
      [100, 102, 103, 104],
    );
    console.log("Cleanup deletes only expired bot-owned candidate drafts.");
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
}

if (process.argv[2] === "gh") fakeGithub(process.argv.slice(3));
else runFixture();
