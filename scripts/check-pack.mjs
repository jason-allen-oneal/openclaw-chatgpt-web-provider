import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";

await access(new URL("../dist/index.js", import.meta.url));

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
});
const [pack] = JSON.parse(output);
const files = new Set(pack.files.map((entry) => entry.path));

if (!files.has("dist/index.js")) {
  throw new Error("package dry-run does not contain dist/index.js");
}

const leakedTests = [...files].filter((file) => /(?:\.test\.|\/tests?\/)/.test(file));
if (leakedTests.length > 0) {
  throw new Error(`package dry-run contains test artifacts: ${leakedTests.join(", ")}`);
}

console.log(`package dry-run verified ${files.size} files with dist/index.js`);
