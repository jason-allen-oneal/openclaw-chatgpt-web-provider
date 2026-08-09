import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const profileDir = process.argv[2];
if (!profileDir) throw new Error("profile directory argument is required");

const chromiumVersion = execFileSync("/usr/bin/chromium", ["--version"], {
  encoding: "utf8",
})
  .match(/([0-9]+(?:\.[0-9]+){3})/)?.[1];
if (!chromiumVersion) throw new Error("Could not resolve the Chromium version");

const context = await chromium.launchPersistentContext(profileDir, {
  executablePath: "/usr/bin/chromium",
  headless: true,
  acceptDownloads: false,
  viewport: { width: 1440, height: 1000 },
  screen: { width: 1440, height: 1000 },
  locale: "en-US",
  userAgent:
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`,
  extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  args: [
    "--disable-setuid-sandbox",
    "--headless=new",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1440,1000",
  ],
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
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4_000);
  const sidebarToggle = page.getByRole("button", { name: /sidebar/i }).first();
  if (await sidebarToggle.isVisible().catch(() => false)) {
    await sidebarToggle.click().catch(() => undefined);
    await page.waitForTimeout(1_000);
  }
  const hrefs = await page
    .locator('a[href^="/c/"]')
    .evaluateAll((anchors) =>
      anchors
        .map((anchor) => anchor.getAttribute("href"))
        .filter((href) => typeof href === "string"),
    );
  const internalPatterns = await page.locator('a[href]').evaluateAll((anchors) => {
    const counts = new Map();
    for (const anchor of anchors) {
      const raw = anchor.getAttribute("href");
      if (!raw) continue;
      let pathname;
      try {
        const url = new URL(raw, "https://chatgpt.com/");
        if (url.origin !== "https://chatgpt.com") continue;
        pathname = url.pathname
          .split("/")
          .map((segment) =>
            segment.length >= 16 || /^[0-9a-f-]{12,}$/i.test(segment) ? ":id" : segment,
          )
          .join("/");
      } catch {
        continue;
      }
      counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
    }
    return Object.fromEntries([...counts.entries()].sort());
  });
  const recent = [...new Set(hrefs)].slice(0, 50);
  const matches = [];
  for (const href of recent) {
    await page.goto(new URL(href, "https://chatgpt.com/").toString(), {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1_000);
    const isCanary = await page
      .locator('[data-message-author-role="user"]')
      .evaluateAll((messages) => {
        const requestMarkerPattern = /^OPENCLAW_REQUEST:[A-Za-z0-9-]+:[0-9a-f]{64}$/m;
        return messages.some((message) => requestMarkerPattern.test(message.textContent ?? ""));
      });
    if (isCanary) matches.push(href);
  }
  console.log(
    JSON.stringify({
      recentConversationCount: recent.length,
      canaryConversationCount: matches.length,
      finalOrigin: new URL(page.url()).origin,
      internalPatterns,
      canaryIds: matches.map((href) =>
        createHash("sha256").update(href).digest("hex").slice(0, 12),
      ),
    }),
  );
} finally {
  await context.close();
}
