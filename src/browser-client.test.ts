import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Download, Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserAutomation,
  PlaywrightChatGptWebClient,
  prepareProfileDirectory,
} from "./browser-client.js";
import { resolveChatGptWebConfig, type ChatGptWebConfig } from "./config.js";
import {
  CHATGPT_WEB_INPUT_TOKEN_BUDGET,
  CHATGPT_WEB_MAX_TOKENS,
} from "./limits.js";

type Message = { role: "assistant" | "user"; text: string; completion?: boolean };
type SubmitPlan =
  | "success"
  | "missing-receipt"
  | "wrong-receipt"
  | "wrong-followup"
  | "truncated-user"
  | "mutated-middle"
  | "collapsed-space"
  | "extra-envelope"
  | "popup"
  | "download"
  | "long-response"
  | "long-pause";

class FakeClock {
  value = 1_000;
  now = () => this.value;
  advance(ms: number) {
    this.value += ms;
  }
}

class FakePage {
  readonly messages: Message[];
  readonly plan: SubmitPlan;
  readonly clock: FakeClock;
  configuredUrl = "https://chatgpt.com/";
  currentUrl = this.configuredUrl;
  filled = "";
  closed = false;
  modelOptions = ["GPT-5"];
  reasoningOptions = ["Extended"];
  selectedModel = "";
  selectedReasoning = "";
  noOpSelection = false;
  waitCalls = 0;
  redirectOnSubmit = false;
  redirectWhileWaitingForSend = false;
  sendVisibilityChecks = 0;
  stopClicks = 0;
  onFirstWait: (() => void) | undefined;
  unexpectedClose = vi.fn(async () => {});
  downloadCancel = vi.fn(async () => {});
  listeners = new Map<string, Set<(value: unknown) => void>>();

  constructor(clock: FakeClock, plan: SubmitPlan, initialMessages: Message[] = []) {
    this.clock = clock;
    this.plan = plan;
    this.messages = [...initialMessages];
  }

  async goto(url: string): Promise<null> {
    this.configuredUrl = url;
    this.currentUrl = url;
    return null;
  }

  url(): string {
    return this.currentUrl;
  }

  locator(selector: string): Locator {
    const config = testConfig("");
    if (selector === config.selectors.composer) return castLocator(new FakeLocator(this, "composer"));
    if (selector === config.selectors.send) return castLocator(new FakeLocator(this, "send"));
    if (selector === config.selectors.message) return castLocator(new FakeLocator(this, "message"));
    if (selector === config.selectors.stop) return castLocator(new FakeLocator(this, "stop"));
    if (selector === "#model-picker") return castLocator(new FakeLocator(this, "modelPicker"));
    if (selector === "#model-option") return castLocator(new FakeLocator(this, "modelOption"));
    if (selector === "#reasoning-picker") {
      return castLocator(new FakeLocator(this, "reasoningPicker"));
    }
    if (selector === "#reasoning-option") {
      return castLocator(new FakeLocator(this, "reasoningOption"));
    }
    throw new Error(`unexpected page selector: ${selector}`);
  }

  async waitForTimeout(ms: number): Promise<void> {
    this.waitCalls += 1;
    if (this.waitCalls === 1) this.onFirstWait?.();
    this.clock.advance(ms);
    await new Promise((resolve) => setImmediate(resolve));
    if (this.closed) throw new Error("Target page has been closed");
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  on(event: string, listener: (value: unknown) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (value: unknown) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  submit(): void {
    if (this.redirectOnSubmit) this.currentUrl = "https://example.com/phish";
    if (this.plan === "popup") {
      this.emit("popup", { close: this.unexpectedClose } as unknown as Page);
    }
    if (this.plan === "download") {
      this.emit("download", { cancel: this.downloadCancel } as unknown as Download);
    }
    const submittedText =
      this.plan === "mutated-middle"
        ? this.filled.replace("prompt", "tampered")
        : this.plan === "collapsed-space"
          ? this.filled.replace("␠␠", "␠")
          : this.plan === "extra-envelope"
            ? `injected prefix\n${this.filled}`
          : this.plan === "truncated-user"
            ? this.filled.slice(this.filled.indexOf("End your response with exactly"))
          : this.filled;
    this.messages.push({
      role: "user",
      text: submittedText,
    });
    const receipt = receiptFrom(this.filled);
    if (this.plan === "wrong-followup") {
      this.messages.push({ role: "user", text: "unexpected second user turn" });
      return;
    }
    const text =
      this.plan === "long-response"
        ? `${"a".repeat(CHATGPT_WEB_MAX_TOKENS)}\n${receipt}`
        : this.plan === "missing-receipt"
        ? "answer"
        : this.plan === "wrong-receipt"
          ? "answer\nOPENCLAW_RECEIPT:wrong"
          : `answer\n${receipt}`;
    this.messages.push({
      role: "assistant",
      text,
      completion: this.plan !== "long-pause",
    });
  }
}

class FakeLocator {
  readonly page: FakePage;
  readonly kind:
    | "completion"
    | "composer"
    | "message"
    | "send"
    | "stop"
    | "modelPicker"
    | "modelOption"
    | "reasoningPicker"
    | "reasoningOption";
  readonly index: number | undefined;

  constructor(
    page: FakePage,
    kind:
      | "completion"
      | "composer"
      | "message"
      | "send"
      | "stop"
      | "modelPicker"
      | "modelOption"
      | "reasoningPicker"
      | "reasoningOption",
    index?: number,
  ) {
    this.page = page;
    this.kind = kind;
    this.index = index;
  }

  first(): Locator {
    return castLocator(
      new FakeLocator(this.page, this.kind, this.kind === "completion" ? this.index : 0),
    );
  }

  last(): Locator {
    return castLocator(new FakeLocator(this.page, this.kind, this.page.messages.length - 1));
  }

  nth(index: number): Locator {
    return castLocator(new FakeLocator(this.page, this.kind, index));
  }

  locator(selector: string): Locator {
    const config = testConfig("");
    if (this.kind === "message" && selector === config.selectors.completion) {
      return castLocator(new FakeLocator(this.page, "completion", this.index));
    }
    throw new Error(`unexpected nested selector: ${selector}`);
  }

  async count(): Promise<number> {
    if (this.kind === "message") return this.page.messages.length;
    if (this.kind === "send" || this.kind === "stop" || this.kind === "composer") return 1;
    if (this.kind === "modelPicker" || this.kind === "reasoningPicker") return 1;
    if (this.kind === "modelOption") return this.page.modelOptions.length;
    if (this.kind === "reasoningOption") return this.page.reasoningOptions.length;
    return 0;
  }

  async waitFor(): Promise<void> {}

  async fill(value: string): Promise<void> {
    this.page.filled = value;
  }

  async press(): Promise<void> {
    this.page.submit();
  }

  async click(): Promise<void> {
    if (this.kind === "send") this.page.submit();
    if (this.kind === "stop") this.page.stopClicks += 1;
    if (this.kind === "modelOption" && !this.page.noOpSelection) {
      this.page.selectedModel = this.page.modelOptions[this.index ?? -1] ?? "";
    }
    if (this.kind === "reasoningOption" && !this.page.noOpSelection) {
      this.page.selectedReasoning = this.page.reasoningOptions[this.index ?? -1] ?? "";
    }
  }

  async isVisible(): Promise<boolean> {
    if (this.kind === "completion") {
      return this.page.messages[this.index ?? -1]?.completion === true;
    }
    if (this.kind === "stop") return false;
    if (this.kind === "send" && this.page.redirectWhileWaitingForSend) {
      this.page.sendVisibilityChecks += 1;
      if (this.page.sendVisibilityChecks === 1) {
        this.page.currentUrl = "https://example.com/phish";
        return false;
      }
    }
    return true;
  }

  async isEnabled(): Promise<boolean> {
    return true;
  }

  async innerText(): Promise<string> {
    if (this.kind === "modelPicker") return this.page.selectedModel;
    if (this.kind === "reasoningPicker") return this.page.selectedReasoning;
    if (this.kind === "modelOption") return this.page.modelOptions[this.index ?? -1] ?? "";
    if (this.kind === "reasoningOption") {
      return this.page.reasoningOptions[this.index ?? -1] ?? "";
    }
    return this.page.messages[this.index ?? -1]?.text ?? "";
  }

  async getAttribute(name: string): Promise<string | null> {
    if (name === "aria-selected" && this.kind === "modelOption") {
      return this.page.selectedModel === this.page.modelOptions[this.index ?? -1] ? "true" : "false";
    }
    if (name === "aria-selected" && this.kind === "reasoningOption") {
      return this.page.selectedReasoning === this.page.reasoningOptions[this.index ?? -1]
        ? "true"
        : "false";
    }
    if (name !== "data-message-author-role") return null;
    return this.page.messages[this.index ?? -1]?.role ?? null;
  }

  async evaluate(): Promise<unknown> {
    return await this.innerText();
  }
}

class FakeContext {
  readonly pages: FakePage[];
  readonly close = vi.fn(async () => {});
  readonly once = vi.fn();
  readonly addInitScript = vi.fn(async () => {});
  readonly newPage = vi.fn(async () => {
    const page = this.pages.shift();
    if (!page) throw new Error("browser context crashed");
    return castPage(page);
  });

  constructor(pages: FakePage[]) {
    this.pages = pages;
  }
}

function castLocator(locator: FakeLocator): Locator {
  return locator as unknown as Locator;
}

function castPage(page: FakePage): Page {
  return page as unknown as Page;
}

function castContext(context: FakeContext): BrowserContext {
  return context as unknown as BrowserContext;
}

function testConfig(profileDir: string, mode: "cdp" | "launch" = "launch"): ChatGptWebConfig {
  return {
    ...resolveChatGptWebConfig({ mode, profileDir, executablePath: "/bin/true" }),
    headless: false,
    readyTimeoutMs: 500,
    responseTimeoutMs: 500,
    stabilityWindowMs: 200,
  };
}

function receiptFrom(prompt: string): string {
  return /OPENCLAW_RECEIPT:[a-z0-9-]+/i.exec(prompt)?.[0] ?? "missing";
}

const temporaryDirectories: string[] = [];

async function temporaryProfile(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "chatgpt-web-provider-test-"));
  temporaryDirectories.push(root);
  return path.join(root, "profile");
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("PlaywrightChatGptWebClient", () => {
  it("uses native new-headless compatibility without an X display", async () => {
    const clock = new FakeClock();
    const context = new FakeContext([new FakePage(clock, "success")]);
    const launch = vi.fn(async () => castContext(context));
    const resolveExecutableVersion = vi.fn(async () => "142.0.7444.175");
    const config = {
      ...testConfig(await temporaryProfile()),
      headless: true,
      sandboxMode: "userns" as const,
    };
    const client = new PlaywrightChatGptWebClient(config, {}, {
      automation: { connectOverCDP: vi.fn(), launchPersistentContext: launch },
      nonceFactory: () => "nonce-1",
      now: clock.now,
      resolveExecutableVersion,
    });

    await expect(client.ask("headless prompt")).resolves.toBe("answer");
    expect(resolveExecutableVersion).toHaveBeenCalledWith("/bin/true");
    expect(launch).toHaveBeenCalledWith(
      config.profileDir,
      expect.objectContaining({
        headless: true,
        args: expect.arrayContaining([
          "--disable-setuid-sandbox",
          "--headless=new",
          "--disable-blink-features=AutomationControlled",
          "--window-size=1440,1000",
        ]),
        userAgent: expect.stringContaining("Chrome/142.0.7444.175"),
        viewport: { width: 1440, height: 1000 },
      }),
    );
    expect(context.addInitScript).toHaveBeenCalledOnce();
    await client.close();
  });

  it("closes a launch context when native-headless initialization fails", async () => {
    const context = new FakeContext([]);
    context.addInitScript.mockRejectedValueOnce(new Error("init script rejected"));
    const config = {
      ...testConfig(await temporaryProfile()),
      headless: true,
    };
    const client = new PlaywrightChatGptWebClient(config, {}, {
      automation: {
        connectOverCDP: vi.fn(),
        launchPersistentContext: vi.fn(async () => castContext(context)),
      },
      resolveExecutableVersion: vi.fn(async () => "142.0.7444.175"),
    });

    await expect(client.ask("never submitted")).rejects.toThrow(
      /Failed to initialize native-headless browser compatibility/,
    );
    expect(context.close).toHaveBeenCalledOnce();
    await client.close();
  });
  it("uses a fresh launch context per turn and strips exact receipts", async () => {
    const clock = new FakeClock();
    const first = new FakePage(clock, "success", [
      { role: "assistant", text: "stale answer", completion: true },
    ]);
    const second = new FakePage(clock, "success");
    const context = new FakeContext([first, second]);
    const automation: BrowserAutomation = {
      connectOverCDP: vi.fn(),
      launchPersistentContext: vi.fn(async () => castContext(context)),
    };
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      { automation, nonceFactory: () => "nonce-1", now: clock.now },
    );

    await expect(client.ask("first prompt")).resolves.toBe("answer");
    await expect(client.ask("second prompt")).resolves.toBe("answer");
    expect(automation.launchPersistentContext).toHaveBeenCalledTimes(2);
    expect(context.newPage).toHaveBeenCalledTimes(2);
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    await client.close();
    expect(context.close).toHaveBeenCalledTimes(2);
  });

  it("selects configured web model and reasoning options before submission", async () => {
    const clock = new FakeClock();
    const page = new FakePage(clock, "success");
    const context = new FakeContext([page]);
    const config = {
      ...testConfig(await temporaryProfile()),
      selectors: {
        ...testConfig("").selectors,
        modelPicker: "#model-picker",
        modelOption: "#model-option",
        reasoningPicker: "#reasoning-picker",
        reasoningOption: "#reasoning-option",
      },
    };
    const client = new PlaywrightChatGptWebClient(config, {}, {
      automation: {
        connectOverCDP: vi.fn(),
        launchPersistentContext: vi.fn(async () => castContext(context)),
      },
      nonceFactory: () => "nonce-1",
      now: clock.now,
    });

    await expect(
      client.ask("prompt", undefined, {
        model: {
          id: "gpt-5",
          name: "ChatGPT Web GPT-5",
          reasoning: true,
          webLabel: "GPT-5",
          reasoningOptions: { high: "Extended" },
        },
        reasoning: "high",
      }),
    ).resolves.toBe("answer");
    expect(page.selectedModel).toBe("GPT-5");
    expect(page.selectedReasoning).toBe("Extended");
    await client.close();
  });

  it("fails closed when a requested web model has no picker selectors", async () => {
    const clock = new FakeClock();
    const page = new FakePage(clock, "success");
    const context = new FakeContext([page]);
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      {
        automation: {
          connectOverCDP: vi.fn(),
          launchPersistentContext: vi.fn(async () => castContext(context)),
        },
        nonceFactory: () => "nonce-1",
        now: clock.now,
      },
    );

    await expect(
      client.ask("prompt", undefined, {
        model: {
          id: "gpt-5",
          name: "ChatGPT Web GPT-5",
          reasoning: true,
          webLabel: "GPT-5",
          reasoningOptions: {},
        },
      }),
    ).rejects.toThrow(/selectors\.modelPicker/);
    expect(page.filled).toBe("");
    await client.close();
  });

  it("fails closed when a requested reasoning level has no picker selectors", async () => {
    const clock = new FakeClock();
    const page = new FakePage(clock, "success");
    const context = new FakeContext([page]);
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      {
        automation: {
          connectOverCDP: vi.fn(),
          launchPersistentContext: vi.fn(async () => castContext(context)),
        },
        nonceFactory: () => "nonce-1",
        now: clock.now,
      },
    );

    await expect(
      client.ask("prompt", undefined, {
        model: {
          id: "gpt-5",
          name: "ChatGPT Web GPT-5",
          reasoning: true,
          reasoningOptions: { high: "Extended" },
        },
        reasoning: "high",
      }),
    ).rejects.toThrow(/selectors\.reasoningPicker/);
    expect(page.filled).toBe("");
    await client.close();
  });

  it("rejects a picker click that does not report committed state", async () => {
    const clock = new FakeClock();
    const page = new FakePage(clock, "success");
    page.noOpSelection = true;
    const context = new FakeContext([page]);
    const base = testConfig(await temporaryProfile());
    const config = {
      ...base,
      selectors: {
        ...base.selectors,
        modelPicker: "#model-picker",
        modelOption: "#model-option",
      },
    };
    const client = new PlaywrightChatGptWebClient(config, {}, {
      automation: {
        connectOverCDP: vi.fn(),
        launchPersistentContext: vi.fn(async () => castContext(context)),
      },
      nonceFactory: () => "nonce-1",
      now: clock.now,
    });

    await expect(
      client.ask("prompt", undefined, {
        model: {
          id: "gpt-5",
          name: "ChatGPT Web GPT-5",
          reasoning: true,
          webLabel: "GPT-5",
          reasoningOptions: {},
        },
      }),
    ).rejects.toThrow(/did not report a committed selection/);
    expect(page.filled).toBe("");
    await client.close();
  });

  it("serializes concurrent turns before acquiring the next browser context", async () => {
    const clock = new FakeClock();
    const firstPage = new FakePage(clock, "success");
    const secondPage = new FakePage(clock, "success");
    const firstContext = new FakeContext([firstPage]);
    const secondContext = new FakeContext([secondPage]);
    let launchCount = 0;
    const launch = vi.fn(async () => {
      launchCount += 1;
      if (launchCount === 1) return castContext(firstContext);
      expect(firstPage.closed).toBe(true);
      expect(firstContext.close).toHaveBeenCalledOnce();
      return castContext(secondContext);
    });
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      {
        automation: { connectOverCDP: vi.fn(), launchPersistentContext: launch },
        nonceFactory: () => `nonce-${launchCount}`,
        now: clock.now,
      },
    );

    const first = client.ask("first concurrent prompt");
    const second = client.ask("second concurrent prompt");
    await expect(Promise.all([first, second])).resolves.toEqual(["answer", "answer"]);
    expect(launch).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it("rejects an expanded transport envelope above the configured maximum", async () => {
    const clock = new FakeClock();
    const page = new FakePage(clock, "success");
    const context = new FakeContext([page]);
    const config = {
      ...testConfig(await temporaryProfile()),
      maxPromptChars: 1_000,
    };
    const client = new PlaywrightChatGptWebClient(config, {}, {
      automation: {
        connectOverCDP: vi.fn(),
        launchPersistentContext: vi.fn(async () => castContext(context)),
      },
      nonceFactory: () => "nonce-1",
      now: clock.now,
    });

    await expect(client.ask("é".repeat(900))).rejects.toThrow(
      /prompt transport .* above the configured maximum/,
    );
    expect(page.filled).toBe("");
    expect(page.closed).toBe(true);
    expect(context.close).toHaveBeenCalledOnce();
    await client.close();
  });

  it("enforces the combined encoded input and output token budget", async () => {
    const clock = new FakeClock();
    const safePage = new FakePage(clock, "success");
    const safeContext = new FakeContext([safePage]);
    const safeClient = new PlaywrightChatGptWebClient(
      { ...testConfig(await temporaryProfile()), maxPromptChars: 60_000 },
      {},
      {
        automation: {
          connectOverCDP: vi.fn(),
          launchPersistentContext: vi.fn(async () => castContext(safeContext)),
        },
        nonceFactory: () => "nonce-safe",
        now: clock.now,
      },
    );

    await expect(safeClient.ask("a".repeat(CHATGPT_WEB_INPUT_TOKEN_BUDGET - 1_000))).resolves.toBe(
      "answer",
    );
    await safeClient.close();

    const overPage = new FakePage(clock, "success");
    const overContext = new FakeContext([overPage]);
    const overClient = new PlaywrightChatGptWebClient(
      { ...testConfig(await temporaryProfile()), maxPromptChars: 60_000 },
      {},
      {
        automation: {
          connectOverCDP: vi.fn(),
          launchPersistentContext: vi.fn(async () => castContext(overContext)),
        },
        nonceFactory: () => "nonce-over",
        now: clock.now,
      },
    );

    await expect(overClient.ask("a".repeat(CHATGPT_WEB_INPUT_TOKEN_BUDGET))).rejects.toThrow(
      /configured maximum input budget/,
    );
    expect(overPage.filled).toBe("");
    await overClient.close();
  });

  it("uses the encoded byte upper bound for high-density input", async () => {
    const clock = new FakeClock();
    const page = new FakePage(clock, "success");
    const context = new FakeContext([page]);
    const client = new PlaywrightChatGptWebClient(
      { ...testConfig(await temporaryProfile()), maxPromptChars: 60_000 },
      {},
      {
        automation: {
          connectOverCDP: vi.fn(),
          launchPersistentContext: vi.fn(async () => castContext(context)),
        },
        nonceFactory: () => "nonce-dense",
        now: clock.now,
      },
    );

    await expect(client.ask("é".repeat(8_000))).rejects.toThrow(
      /configured maximum input budget/,
    );
    expect(page.filled).toBe("");
    await client.close();
  });

  it("stops and rejects a browser response above the output budget", async () => {
    const clock = new FakeClock();
    const page = new FakePage(clock, "long-response");
    const context = new FakeContext([page]);
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      {
        automation: {
          connectOverCDP: vi.fn(),
          launchPersistentContext: vi.fn(async () => castContext(context)),
        },
        nonceFactory: () => "nonce-output",
        now: clock.now,
      },
    );

    await expect(client.ask("small prompt")).rejects.toThrow(
      /configured maximum of 8192 output tokens/,
    );
    expect(page.stopClicks).toBe(1);
    await client.close();
  });

  it.each([
    ["missing-receipt", /missing the exact OpenClaw transport receipt/],
    ["wrong-receipt", /missing the exact OpenClaw transport receipt/],
    ["wrong-followup", /immediately following.*not an assistant response/],
    ["truncated-user", /missing this OpenClaw request binding/],
    ["mutated-middle", /missing this OpenClaw request binding/],
    ["collapsed-space", /missing this OpenClaw request binding/],
    ["extra-envelope", /missing this OpenClaw request binding/],
  ] as const)("rejects an integrity failure: %s", async (plan, expected) => {
    const clock = new FakeClock();
    const page = new FakePage(clock, plan);
    const context = new FakeContext([page]);
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      {
        automation: {
          connectOverCDP: vi.fn(),
          launchPersistentContext: vi.fn(async () => castContext(context)),
        },
        nonceFactory: () => "nonce-1",
        now: clock.now,
      },
    );
    await expect(
      client.ask(plan === "collapsed-space" ? "prompt  with repeated spaces" : "prompt"),
    ).rejects.toThrow(expected);
    await client.close();
  });

  it.each([
    ["popup", /unexpected popup/, "unexpectedClose"],
    ["download", /unexpected download/, "downloadCancel"],
  ] as const)("rejects and closes an unexpected browser boundary: %s", async (plan, expected, spy) => {
    const clock = new FakeClock();
    const page = new FakePage(clock, plan);
    const context = new FakeContext([page]);
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      {
        automation: {
          connectOverCDP: vi.fn(),
          launchPersistentContext: vi.fn(async () => castContext(context)),
        },
        nonceFactory: () => "nonce-1",
        now: clock.now,
      },
    );
    await expect(client.ask("prompt")).rejects.toThrow(expected);
    expect(page[spy]).toHaveBeenCalledOnce();
    await client.close();
  });

  it("rejects a redirect after submit before reading the receipt or response", async () => {
    const clock = new FakeClock();
    const page = new FakePage(clock, "success");
    page.redirectOnSubmit = true;
    const context = new FakeContext([page]);
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      {
        automation: {
          connectOverCDP: vi.fn(),
          launchPersistentContext: vi.fn(async () => castContext(context)),
        },
        nonceFactory: () => "nonce-1",
        now: clock.now,
      },
    );
    await expect(client.ask("prompt")).rejects.toThrow(/left the configured ChatGPT origin/);
    await client.close();
  });

  it("rechecks the origin while waiting for a usable send control", async () => {
    const clock = new FakeClock();
    const page = new FakePage(clock, "success");
    page.redirectWhileWaitingForSend = true;
    const context = new FakeContext([page]);
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      {
        automation: {
          connectOverCDP: vi.fn(),
          launchPersistentContext: vi.fn(async () => castContext(context)),
        },
        nonceFactory: () => "nonce-1",
        now: clock.now,
      },
    );
    await expect(client.ask("prompt")).rejects.toThrow(/left the configured ChatGPT origin/);
    expect(page.messages).toHaveLength(0);
    await client.close();
  });

  it("rejects a cross-origin main-frame navigation that races response extraction", async () => {
    const clock = new FakeClock();
    const page = new FakePage(clock, "success");
    const context = new FakeContext([page]);
    page.onFirstWait = () => {
      page.emit("framenavigated", {
        parentFrame: () => null,
        url: () => "https://example.com/phish",
      });
    };
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      {
        automation: {
          connectOverCDP: vi.fn(),
          launchPersistentContext: vi.fn(async () => castContext(context)),
        },
        nonceFactory: () => "nonce-1",
        now: clock.now,
      },
    );
    await expect(client.ask("prompt")).rejects.toThrow(/left the configured ChatGPT origin/);
    await client.close();
  });

  it("does not accept a long quiet pause without a positive completion signal", async () => {
    const clock = new FakeClock();
    const page = new FakePage(clock, "long-pause");
    const context = new FakeContext([page]);
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      {
        automation: {
          connectOverCDP: vi.fn(),
          launchPersistentContext: vi.fn(async () => castContext(context)),
        },
        nonceFactory: () => "nonce-1",
        now: clock.now,
      },
    );
    await expect(client.ask("prompt")).rejects.toThrow(/positive completion signal/);
    expect(page.stopClicks).toBeGreaterThan(0);
    await client.close();
  });

  it("cancels an active turn, rejects queued work on close, and drains before closing", async () => {
    const clock = new FakeClock();
    const active = new FakePage(clock, "long-pause");
    const neverOpened = new FakePage(clock, "success");
    const context = new FakeContext([active, neverOpened]);
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      {
        automation: {
          connectOverCDP: vi.fn(),
          launchPersistentContext: vi.fn(async () => castContext(context)),
        },
        nonceFactory: () => "nonce-1",
        now: clock.now,
      },
    );
    let queued: Promise<string> | undefined;
    let closing: Promise<void> | undefined;
    active.onFirstWait = () => {
      queued = client.ask("queued");
      closing = client.close();
    };
    const first = client.ask("first");
    await expect(first).rejects.toThrow(/request was aborted/);
    expect(queued).toBeDefined();
    expect(closing).toBeDefined();
    await expect(queued!).rejects.toThrow(/client is closed/);
    await closing;
    expect(context.newPage).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    await expect(client.ask("after close")).rejects.toThrow(/client is closed/);
  });

  it("recovers with a new launch context after an aborted turn", async () => {
    const clock = new FakeClock();
    const abortedPage = new FakePage(clock, "long-pause");
    const recoveredPage = new FakePage(clock, "success");
    const context = new FakeContext([abortedPage, recoveredPage]);
    const launch = vi.fn(async () => castContext(context));
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      {
        automation: { connectOverCDP: vi.fn(), launchPersistentContext: launch },
        nonceFactory: () => "nonce-1",
        now: clock.now,
      },
    );
    const controller = new AbortController();
    abortedPage.onFirstWait = () => controller.abort();
    const first = client.ask("first", controller.signal);
    await expect(first).rejects.toThrow(/request was aborted/);
    await expect(client.ask("second")).resolves.toBe("answer");
    expect(launch).toHaveBeenCalledTimes(2);
    expect(context.newPage).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it("disposes a CDP connection during close", async () => {
    const clock = new FakeClock();
    const context = new FakeContext([new FakePage(clock, "success")]);
    const browser = {
      contexts: () => [castContext(context)],
      close: vi.fn(async () => {}),
      once: vi.fn(),
    } as unknown as Browser;
    const client = new PlaywrightChatGptWebClient(
      testConfig("/unused", "cdp"),
      {},
      {
        automation: {
          connectOverCDP: vi.fn(async () => browser),
          launchPersistentContext: vi.fn(),
        },
        nonceFactory: () => "nonce-1",
        now: clock.now,
      },
    );
    await expect(client.ask("prompt")).resolves.toBe("answer");
    await client.close();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(context.close).not.toHaveBeenCalled();
  });

  it("reconnects once when a new context crashes before creating its page", async () => {
    const clock = new FakeClock();
    const firstContext = new FakeContext([]);
    const recoveredContext = new FakeContext([new FakePage(clock, "success")]);
    const launch = vi
      .fn()
      .mockResolvedValueOnce(castContext(firstContext))
      .mockResolvedValueOnce(castContext(recoveredContext));
    const client = new PlaywrightChatGptWebClient(
      testConfig(await temporaryProfile()),
      {},
      {
        automation: { connectOverCDP: vi.fn(), launchPersistentContext: launch },
        nonceFactory: () => "nonce-1",
        now: clock.now,
      },
    );
    await expect(client.ask("after crash")).resolves.toBe("answer");
    expect(launch).toHaveBeenCalledTimes(2);
    expect(firstContext.close).toHaveBeenCalledOnce();
    await client.close();
  });
});

describe("prepareProfileDirectory", () => {
  it("creates a private dedicated directory", async () => {
    const profile = await temporaryProfile();
    await prepareProfileDirectory(profile);
    await expect(prepareProfileDirectory(profile)).resolves.toBeUndefined();
    expect((await stat(profile)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(profile, ".openclaw-chatgpt-web-profile"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("rejects normal browser profile paths", async () => {
    await expect(
      prepareProfileDirectory(path.join(process.env.HOME ?? "/", ".config/google-chrome/Default")),
    ).rejects.toThrow(/dedicated provider directory/);
  });

  it("rejects an unmarked nonempty directory", async () => {
    const profile = await temporaryProfile();
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, "unrelated.txt"), "do not commandeer\n");
    await expect(prepareProfileDirectory(profile)).rejects.toThrow(/ownership marker/);
  });

  it("rejects a profile path containing a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatgpt-web-provider-link-test-"));
    temporaryDirectories.push(root);
    const target = path.join(root, "target");
    const linked = path.join(root, "linked");
    await mkdir(target);
    await symlink(target, linked);
    await expect(prepareProfileDirectory(path.join(linked, "profile"))).rejects.toThrow(
      /symbolic links/,
    );
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}
