import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  type BrowserAutomation,
  PlaywrightChatGptWebClient,
} from "./browser-client.js";
import { resolveChatGptWebConfig } from "./config.js";

const CHROMIUM_PATH = "/usr/bin/chromium";
const fixtureTest = existsSync(CHROMIUM_PATH) ? it : it.skip;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

fixtureTest(
  "executes the real selectors against a fully intercepted Chromium fixture",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatgpt-web-fixture-"));
    temporaryDirectories.push(root);
    const interceptedUrls: string[] = [];
    let context: BrowserContext | undefined;
    const automation: BrowserAutomation = {
      connectOverCDP: vi.fn(),
      launchPersistentContext: vi.fn(async (userDataDir, options) => {
        context = await chromium.launchPersistentContext(userDataDir, options);
        await context.route("**/*", async (route) => {
          const url = route.request().url();
          interceptedUrls.push(url);
          if (new URL(url).origin === "https://chatgpt.com") {
            await route.fulfill({
              status: 200,
              contentType: "text/html",
              body: fixtureHtml(),
            });
            return;
          }
          await route.abort("blockedbyclient");
        });
        return context;
      }),
    };
    const config = {
      ...resolveChatGptWebConfig({
        profileDir: path.join(root, "profile"),
        executablePath: CHROMIUM_PATH,
        headless: true,
      }),
      readyTimeoutMs: 3_000,
      responseTimeoutMs: 3_000,
      stabilityWindowMs: 250,
    };
    const client = new PlaywrightChatGptWebClient(config, {}, {
      automation,
      nonceFactory: () => "fixture-nonce",
    });

    await expect(client.ask("synthetic fixture prompt")).resolves.toBe("fixture answer");
    expect(interceptedUrls).toContain("https://chatgpt.com/");
    expect(interceptedUrls.every((url) => new URL(url).origin === "https://chatgpt.com")).toBe(true);
    await client.close();
    expect(context).toBeDefined();
  },
  15_000,
);

function fixtureHtml(): string {
  return String.raw`<!doctype html>
<html>
  <body>
    <main id="messages"></main>
    <form data-type="unified-composer">
      <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
      <button type="button" data-testid="send-button">Send</button>
    </form>
    <script>
      const messages = document.querySelector("#messages");
      const composer = document.querySelector("#prompt-textarea");
      document.querySelector("[data-testid=send-button]").addEventListener("click", () => {
        const prompt = composer.innerText;
        const receipt = prompt.match(/OPENCLAW_RECEIPT:[a-z0-9-]+/i)?.[0];
        const user = document.createElement("div");
        user.dataset.messageAuthorRole = "user";
        user.dataset.messageId = "fixture-user";
        user.innerText = prompt;
        messages.append(user);
        const assistant = document.createElement("div");
        assistant.dataset.messageAuthorRole = "assistant";
        assistant.dataset.messageId = "fixture-assistant";
        const final = document.createElement("div");
        final.dataset.messageContentPart = "final";
        final.innerText = "fixture answer\n" + receipt;
        assistant.append(final);
        messages.append(assistant);
      });
    </script>
  </body>
</html>`;
}
