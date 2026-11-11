import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
try {
  if (fs.lstatSync(output).isSymbolicLink()) throw new Error("Refusing to build into a symlinked dist directory.");
  try { fs.lstatSync(path.join(output, "data")); throw new Error("Refusing to build over dist/data; preserve plugin data outside dist first."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
} catch (error) { if (error.code !== "ENOENT") throw error; }
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const common = { absWorkingDir: root, bundle: true, target: "es2022", minify: true, legalComments: "eof", metafile: true };
const frontend = await build({ ...common, entryPoints: ["src/main.ts"], outfile: path.join(output, "main.js"), format: "esm", platform: "browser" });
// ws optionally loads native accelerators inside try/catch; they are not shipped.
const backend = await build({ ...common, entryPoints: ["src/backend.ts"], outfile: path.join(output, "backend.cjs"), format: "cjs", platform: "node",
  external: ["bufferutil", "utf-8-validate"] });
// iPad companion page: served only by the opt-in LAN companion server.
const companion = await build({ ...common, entryPoints: ["src/companion/page/app.ts"], outfile: path.join(output, "companion/app.js"),
  format: "iife", platform: "browser", target: ["safari15"] });
for (const result of [frontend, backend, companion]) for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.startsWith("src/") && !input.startsWith("node_modules/")) throw new Error(`Unexpected runtime input: ${input}`);
}
for (const file of ["manifest.json", "README.md", "LICENSE", "THIRD-PARTY.md"]) fs.copyFileSync(path.join(root, file), path.join(output, file));
fs.copyFileSync(path.join(root, "src/styles.css"), path.join(output, "styles.css"));
for (const file of ["index.html", "app.css"]) fs.copyFileSync(path.join(root, "src/companion/page", file), path.join(output, "companion", file));
fs.mkdirSync(path.join(output, "licenses"));
fs.copyFileSync(path.join(root, "node_modules/html-to-image/LICENSE"), path.join(output, "licenses/html-to-image-LICENSE"));
fs.copyFileSync(path.join(root, "node_modules/ws/LICENSE"), path.join(output, "licenses/ws-LICENSE"));
fs.copyFileSync(path.join(root, "node_modules/perfect-freehand/LICENSE"), path.join(output, "licenses/perfect-freehand-LICENSE"));
// qrcode-generator ships its MIT notice in source headers rather than a LICENSE file.
fs.copyFileSync(path.join(root, "licenses/qrcode-generator-LICENSE"), path.join(output, "licenses/qrcode-generator-LICENSE"));
console.log(`Built Drawing Pad plugin only: ${output}`);
