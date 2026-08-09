import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = path.resolve(projectRoot, "dist");
if (path.dirname(dist) !== projectRoot || path.basename(dist) !== "dist") {
  throw new Error(`refusing to clean unexpected build directory: ${dist}`);
}

await rm(dist, { recursive: true, force: true });
