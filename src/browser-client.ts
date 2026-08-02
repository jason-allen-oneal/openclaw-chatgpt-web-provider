import { access } from "node:fs/promises";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import type { ChatGptWebConfig } from "./config.js";

export interface BrowserClientLogger {
  debug?(fields: unknown, message?: string): void;
  info?(fields: unknown, message?: string): void;
  warn?(fields: unknown, message?: string): void;
  error?(fields: unknown, message?: string): void;
}

export interface ChatGptWebClient {
  ask(prompt: string, signal?: AbortSignal): Promise<string>;
}

export class PlaywrightChatGptWebClient implements ChatGptWebClient {
  readonly #config: ChatGptWebConfig;
  readonly #logger: BrowserClientLogger;
  #browser?: Browser;
  #context?: BrowserContext;
  #page?: Page;
  #tail: Promise<void> = Promise.resolve();

  constructor(config: ChatGptWebConfig, logger: BrowserClientLogger = {}) {
    this.#config = config;
    this.#logger = logger;
  }

  async ask(prompt: string, signal?: AbortSignal): Promise<string> {
    const run = this.#enqueue(async () => {
      throwIfAborted(signal);
      const page = await this.#getPage(signal);
      const stopOnAbort = () => {
        void this.#abortActiveTurn(page);
      };
      signal?.addEventListener("abort", stopOnAbort, { once: true });
      try {
        return await this.#runTurn(page, prompt, signal);
      } finally {
        signal?.removeEventListener("abort", stopOnAbort);
      }
    });
    return await observeAbort(run, signal);
  }

  async close(): Promise<void> {
    const page = this.#page;
    this.#page = undefined;
    await page?.close().catch(() => undefined);
    if (this.#config.mode === "launch") {
      await this.#context?.close().catch(() => undefined);
    }
    this.#context = undefined;
    this.#browser = undefined;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #getPage(signal?: AbortSignal): Promise<Page> {
    if (this.#page && !this.#page.isClosed()) return this.#page;

    if (this.#config.mode === "cdp") {
      const browser = await chromium.connectOverCDP(this.#config.cdpUrl);
      if (signal?.aborted) {
        // CDP is contractually dedicated to this provider, so aborting acquisition may close it.
        await browser.close().catch(() => undefined);
        throwIfAborted(signal);
      }
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close().catch(() => undefined);
        throw new Error("No browser context is available over CDP");
      }
      this.#browser = browser;
      this.#context = context;
    } else {
      const executablePath =
        this.#config.executablePath ?? (await resolveChromiumExecutablePath());
      const context = await chromium.launchPersistentContext(this.#config.profileDir, {
        executablePath,
        headless: this.#config.headless,
      });
      if (signal?.aborted) {
        await context.close().catch(() => undefined);
        throwIfAborted(signal);
      }
      this.#context = context;
    }

    const context = this.#context;
    // Always own the page we navigate. In CDP mode this prevents commandeering user tabs.
    this.#page = await context.newPage();
    return this.#page;
  }

  async #runTurn(page: Page, prompt: string, signal?: AbortSignal): Promise<string> {
    // Stateless navigation avoids duplicating OpenClaw replay inside a retained ChatGPT thread.
    await page.goto(this.#config.webchatUrl, { waitUntil: "domcontentloaded" });
    throwIfAborted(signal);

    const composer = page.locator(this.#config.selectors.composer).first();
    try {
      await composer.waitFor({ state: "visible", timeout: this.#config.readyTimeoutMs });
    } catch (error) {
      throw new Error(
        `ChatGPT is not ready in the dedicated browser profile. Sign in at ${this.#config.webchatUrl}, then restart OpenClaw.`,
        { cause: error },
      );
    }

    const beforeCount = await page.locator(this.#config.selectors.assistant).count();
    await composer.fill(prompt);
    await this.#submit(page, composer, signal);
    const response = await this.#waitForResponse(page, beforeCount, signal);
    const text = await extractResponseText(response, this.#config.selectors.responseContent);
    if (!text) throw new Error("ChatGPT returned an empty browser response");
    this.#logger.info?.({ responseChars: text.length }, "ChatGPT web turn completed");
    return text;
  }

  async #submit(page: Page, composer: Locator, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.#config.readyTimeoutMs;
    const send = page.locator(this.#config.selectors.send);
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const count = await send.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = send.nth(index);
        if (
          (await candidate.isVisible().catch(() => false)) &&
          (await candidate.isEnabled().catch(() => false))
        ) {
          await candidate.click();
          return;
        }
      }
      await page.waitForTimeout(100);
    }
    await composer.press("Enter");
  }

  async #waitForResponse(
    page: Page,
    beforeCount: number,
    signal?: AbortSignal,
  ): Promise<Locator> {
    const deadline = Date.now() + this.#config.responseTimeoutMs;
    let lastText = "";
    let stableSince = Date.now();
    let sawStop = false;
    let latest: Locator | undefined;

    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const assistants = page.locator(this.#config.selectors.assistant);
      const count = await assistants.count();
      if (count <= beforeCount) {
        await page.waitForTimeout(200);
        continue;
      }

      latest = assistants.last();
      const text = await extractResponseText(
        latest,
        this.#config.selectors.responseContent,
      ).catch(() => "");
      const stopVisible = await page
        .locator(this.#config.selectors.stop)
        .first()
        .isVisible()
        .catch(() => false);
      sawStop ||= stopVisible;

      if (text !== lastText) {
        lastText = text;
        stableSince = Date.now();
      } else if (
        text &&
        !stopVisible &&
        (sawStop || Date.now() - stableSince >= this.#config.stabilityWindowMs)
      ) {
        return latest;
      }
      await page.waitForTimeout(200);
    }

    await page.locator(this.#config.selectors.stop).first().click().catch(() => undefined);
    throw new Error("Timed out waiting for ChatGPT to finish its browser response");
  }

  async #abortActiveTurn(page: Page): Promise<void> {
    await page.locator(this.#config.selectors.stop).first().click().catch(() => undefined);
    await page.close().catch(() => undefined);
    if (this.#page === page) this.#page = undefined;
  }
}

async function extractResponseText(response: Locator, contentSelector: string): Promise<string> {
  return await response.evaluate(
    (root, selector) => {
      const candidates = Array.from(root.querySelectorAll<HTMLElement>(selector));
      const topLevel = candidates.filter(
        (candidate) =>
          !candidates.some((other) => other !== candidate && other.contains(candidate)),
      );
      const values = topLevel.map((candidate) => candidate.innerText.trim()).filter(Boolean);
      return (values.length > 0 ? values.join("\n\n") : (root as HTMLElement).innerText).trim();
    },
    contentSelector,
  );
}

async function resolveChromiumExecutablePath(): Promise<string> {
  const candidates = [
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through known system browser locations.
    }
  }
  throw new Error(
    "No Chromium executable was found. Set plugins.entries.chatgpt-web.config.executablePath.",
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("ChatGPT web request was aborted");
}

async function observeAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await operation;
  throwIfAborted(signal);
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error("ChatGPT web request was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeAbortListener();
  }
}
