#!/usr/bin/env node
import { PlaywrightChatGptWebClient } from "../dist/browser-client.js";
import { resolveChatGptWebConfig } from "../dist/config.js";

const profileDir = process.argv[2];
if (!profileDir) throw new Error("profile directory argument is required");

const client = new PlaywrightChatGptWebClient(
  {
    ...resolveChatGptWebConfig({
      profileDir,
      executablePath: "/usr/bin/chromium",
      sandboxMode: "userns",
      headless: true,
    }),
    readyTimeoutMs: 60_000,
    responseTimeoutMs: 120_000,
  },
  {},
  { nonceFactory: () => "synthetic-binding-probe" },
);

try {
  await client.ask("SYNTHETIC BINDING PROBE\n<markup>literal</markup>");
  process.stdout.write("binding-ok\n");
} catch (error) {
  process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  await client.close();
}
