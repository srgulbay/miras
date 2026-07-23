import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");
const files = [
  ".nojekyll",
  "index.html",
  "manifest.webmanifest",
  "robots.txt",
];
const directories = ["audio", "css", "fonts", "img", "js"];

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });

for (const file of files) {
  await fs.copyFile(path.join(root, file), path.join(output, file));
}

for (const directory of directories) {
  await fs.cp(path.join(root, directory), path.join(output, directory), {
    recursive: true,
  });
}

console.log("MİRAS üretim varlıkları hazır.");
