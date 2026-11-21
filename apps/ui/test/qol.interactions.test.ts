import { findBrowser, launchBrowser, Page, parseKeys, pickPage } from "@cerium/browser";
import { describe, expect, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const executable = findBrowser();
if (process.env["CI"] === "true" && executable === undefined) {
  throw new Error("The UI interaction suite requires Edge or Chrome on this runner.");
}

const input = { selector: '[role="combobox"]' };
const click = (page: Page, text: string) => page.click({ text }, { button: "left", count: 1 });
const result = (page: Page) => page.evaluate("document.querySelector('#result').textContent");
const choose = (page: Page, label: string, value: string) =>
  page.evaluate(`{
  const select = [...document.querySelectorAll('label')].find((el) => el.textContent.startsWith(${JSON.stringify(label)})).querySelector('select');
  select.value = ${JSON.stringify(value)};
  select.dispatchEvent(new Event('change', { bubbles: true }));
}`);
const wait = (page: Page, text: string) => page.waitFor({ text }, { timeoutMs: 5_000, gone: false });
const closed = (page: Page) =>
  page.waitFor({ selector: '[role="dialog"]' }, { gone: true, timeoutMs: 5_000 });
const activate = async (page: Page, selector: string) => {
  await page.waitFor({ selector }, { timeoutMs: 5_000, gone: false });
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await page.press(parseKeys("Enter"));
};

// Vite's native resolver needs the main Node realm. The test itself runs in a Vitest VM.
const fixtureServer = `
  import { createServer } from 'vite-plus';
  import tailwindcss from '@tailwindcss/vite';
  const server = await createServer({
    configFile: false,
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { entries: ['test/qolFixture.tsx'] },
    plugins: [tailwindcss(), {
      name: 'cerium-ui-fixture',
      configureServer(server) {
        server.middlewares.use('/fixture', (_request, response) => {
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end('<!doctype html><div id="root"></div><script type="module" src="/test/qolFixture.tsx"></script>');
        });
      },
    }],
  });
  await server.listen();
  process.send(server.resolvedUrls.local[0]);
`;

describe.skipIf(executable === undefined)("command palette and linked tasks in the browser", () => {
  it("activates palette results and manages linked tasks from both sides", async () => {
    const server = spawn(process.execPath, ["--input-type=module", "--eval", fixtureServer], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const exit = once(server, "exit");
    try {
      const origin = await Promise.race([
        once(server, "message", { signal: AbortSignal.timeout(15_000) }).then(([origin]) => String(origin)),
        exit.then(([code]) => {
          throw new Error(`The UI fixture's Vite server exited with code ${code}.`);
        }),
      ]);
      const browser = await launchBrowser({
        executable: executable!,
        visible: false,
        width: 1000,
        height: 900,
      });
      try {
        const page = await Page.open((await pickPage(browser.origin)).webSocketDebuggerUrl);
        try {
          await page.navigate(new URL("fixture", origin).href);
          await click(page, "Open palette");
          await page.type("needle");
          await wait(page, "Archived chat").catch(async (error: unknown) => {
            const contents = await page.evaluate<string>("document.body.innerText");
            throw new Error(`Palette results did not show: ${contents}`, { cause: error });
          });
          await page.press(parseKeys("Control+Enter"));
          await closed(page);
          expect(await result(page)).toBe("chat:tab");

          await click(page, "Open palette");
          await choose(page, "File search project", "/projects/lib");
          await page.type("index", input);
          await wait(page, "src/index.ts");
          await page.press(parseKeys("Alt+Enter"));
          await closed(page);
          expect(await result(page)).toBe("/projects/lib/src/index.ts:split");

          const disclosures = (id: string) =>
            page.evaluate(
              `Array.from(document.querySelectorAll('#${id} button[aria-expanded]'), (el) => el.getAttribute('aria-expanded'))`,
            );
          await click(page, "Open palette");
          await page.type("expand", input);
          await wait(page, "Expand all Worked sections");
          await page.press(parseKeys("Enter"));
          await closed(page);
          expect(await disclosures("work")).toEqual(["true", "true"]);
          expect(await disclosures("chat")).toEqual(["false", "false"]);
          await click(page, "Open palette");
          await page.type("collapse", input);
          await wait(page, "Collapse all Worked sections");
          await page.press(parseKeys("Enter"));
          await closed(page);
          expect(await disclosures("work")).toEqual(["false", "false"]);

          await choose(page, "Filter tasks by project", "project:/projects/app");
          expect(
            await page.evaluate("document.querySelector('#task-list').innerText.includes('Read docs')"),
          ).toBe(false);
          await choose(page, "Link an existing task", "task");
          await wait(page, "Running");
          await activate(page, '#task-list [aria-label="Linked threads"] button');
          await expect.poll(() => result(page)).toBe("thread:work");
          await activate(page, 'section[aria-label="Linked tasks"] li button');
          await expect.poll(() => result(page)).toBe("task:task");
          expect(await page.evaluate("document.body.innerText.includes('Mark task done')")).toBe(false);
          await activate(page, "#finish-thread");
          await wait(page, "Idle");
          await activate(page, '[aria-label="Mark Check deployment done"]');
          expect(
            await page.evaluate(
              "document.querySelector('section[aria-label=\"Linked tasks\"] li').textContent",
            ),
          ).toContain("Done");
          await activate(page, '[aria-label="Unlink Check deployment"]');
          expect(
            await page.evaluate("document.querySelector('section[aria-label=\"Linked tasks\"] li')"),
          ).toBeNull();
          expect(await page.evaluate("document.querySelector('[aria-label=\"Linked threads\"]')")).toBeNull();

          await activate(page, "#message button");
          expect(
            await page.evaluate(
              "document.querySelector('section[aria-label=\"Linked tasks\"] li').textContent",
            ),
          ).toContain("Follow up on deploy");
          await page.type("Review follow-up", { text: "Add a task" });
          await page.press(parseKeys("Tab"));
          expect(await result(page)).toMatch(/^handoff:[\w-]+:Review follow-up$/u);

          await activate(page, 'section[aria-label="Issue 42"] button[aria-label="More"]');
          await wait(page, "Open on GitHub");
          await activate(page, '[role="menuitem"]');
          expect(await page.evaluate("document.querySelector('#task-list').innerText")).toContain(
            "#42 Fix CI",
          );
        } finally {
          page.close();
        }
      } finally {
        await browser.close();
      }
    } finally {
      server.kill();
      await exit;
    }
  });
});
