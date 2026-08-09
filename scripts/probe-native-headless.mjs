#!/usr/bin/env node
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";

const profileDir = process.argv[2];
const mode = process.argv[3] ?? "compat";
if (!profileDir) {
  throw new Error("Usage: probe-native-headless.mjs <profile-dir> [baseline|new|compat]");
}
if (!new Set(["baseline", "new", "compat"]).has(mode)) {
  throw new Error(`Unknown probe mode: ${mode}`);
}

const args = ["--disable-setuid-sandbox", "--window-size=1440,1000"];
if (mode !== "baseline") args.push("--headless=new");
if (mode === "compat") args.push("--disable-blink-features=AutomationControlled");

const chromiumVersion = execFileSync("/usr/bin/chromium", ["--version"], {
  encoding: "utf8",
})
  .match(/([0-9]+(?:\.[0-9]+){3})/)?.[1];
if (!chromiumVersion) throw new Error("Could not resolve the Chromium version");
const normalizedUserAgent =
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`;

const context = await chromium.launchPersistentContext(profileDir, {
  executablePath: "/usr/bin/chromium",
  headless: true,
  args,
  viewport: { width: 1440, height: 1000 },
  screen: { width: 1440, height: 1000 },
  locale: "en-US",
  ...(mode === "compat"
    ? {
        userAgent: normalizedUserAgent,
        extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
      }
    : {}),
});

try {
  if (mode === "compat") {
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
  }
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://chatgpt.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const composer = page.locator(
    'form[data-type="unified-composer"] #prompt-textarea[contenteditable="true"][role="textbox"], #prompt-textarea[contenteditable="true"][role="textbox"]',
  ).first();
  let composerVisible = false;
  try {
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    composerVisible = true;
  } catch {
    // The probe reports only readiness metadata and never page or account content.
  }
  const finalUrl = new URL(page.url());
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const webdriver = await page.evaluate(() => navigator.webdriver);
  const diagnostic = await page.evaluate(() => {
    const title = document.title.toLowerCase();
    const body = document.body?.innerText.toLowerCase() ?? "";
    return {
      challengeTitle: title.includes("just a moment") || title.includes("attention required"),
      challengeText:
        body.includes("verify you are human") ||
        body.includes("checking your browser") ||
        body.includes("performing security verification"),
      challengeFrame: Array.from(document.querySelectorAll("iframe")).some((frame) =>
        /challenge|turnstile|captcha/i.test(frame.src),
      ),
      loginControl: Array.from(document.querySelectorAll("a,button")).some((element) =>
        /^log in$|^sign in$/i.test(element.textContent?.trim() ?? ""),
      ),
    };
  });
  process.stdout.write(
    `${JSON.stringify({
      mode,
      composerVisible,
      origin: finalUrl.origin,
      pathKind: finalUrl.pathname === "/" ? "/" : "other",
      userAgentHasHeadless: userAgent.includes("HeadlessChrome"),
      webdriver: webdriver === undefined ? "undefined" : String(webdriver),
      ...diagnostic,
    })}\n`,
  );
  if (!composerVisible) process.exitCode = 2;
} finally {
  await context.close();
}
