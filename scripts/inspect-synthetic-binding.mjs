#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const profileDir = process.argv[2];
if (!profileDir) throw new Error("profile directory argument is required");
const version = execFileSync("/usr/bin/chromium", ["--version"], { encoding: "utf8" })
  .match(/([0-9]+(?:\.[0-9]+){3})/)?.[1];
if (!version) throw new Error("could not resolve Chromium version");

const context = await chromium.launchPersistentContext(profileDir, {
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: [
    "--disable-setuid-sandbox",
    "--headless=new",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1440,1000",
  ],
  viewport: { width: 1440, height: 1000 },
  screen: { width: 1440, height: 1000 },
  locale: "en-US",
  userAgent:
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${version} Safari/537.36`,
  extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
});

try {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      configurable: true,
      get: () => undefined,
    });
    Object.defineProperty(Navigator.prototype, "languages", {
      configurable: true,
      get: () => ["en-US", "en"],
    });
    Object.defineProperty(Navigator.prototype, "plugins", {
      configurable: true,
      get: () => [1, 2, 3, 4, 5],
    });
  });
  const page = await context.newPage();
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  const composer = page.locator('#prompt-textarea[contenteditable="true"][role="textbox"]').first();
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  const messages = page.locator("[data-message-author-role][data-message-id]");
  const before = await messages.count();
  const synthetic = [
    "OPENCLAW_REQUEST:synthetic-binding-probe:digest",
    "",
    "Read the single transport context below directly: letters and digits are literal; ␠ is space; ␊ is newline; fullwidth punctuation means its ASCII counterpart; ［uXXXX］ is an original UTF-16 code unit.",
    "",
    "OPENCLAW_CONTEXT_BEGIN:synthetic-binding-probe",
    "SYNTHETIC␠BINDING␠PROBE␊＜markup＞literal＜／markup＞",
    "OPENCLAW_CONTEXT_END:synthetic-binding-probe",
    "",
    "End your response with exactly OPENCLAW_RECEIPT:synthetic-binding-probe on its own final line.",
  ].join("\n");
  await composer.fill(synthetic);
  await page.locator('button[data-testid="send-button"]').first().click();
  await page.waitForFunction(
    ({ selector, count }) => document.querySelectorAll(selector).length > count,
    { selector: "[data-message-author-role][data-message-id]", count: before },
    { timeout: 60_000 },
  );
  const submitted = messages.nth(before);
  const result = await submitted.evaluate((element) => ({
    innerText: element.innerText,
    codeBlocks: Array.from(element.querySelectorAll("pre code")).map(
      (code) => code.textContent ?? "",
    ),
  }));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await context.close();
}
