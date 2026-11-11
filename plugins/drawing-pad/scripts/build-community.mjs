// Packages this Drawing Pad build as a separately-identified Community plugin so it
// can be used with an INSTALLED LearnHarness release without rebuilding the app.
// `drawing-pad` is a reserved Core ID, so the copy uses its own ID. Disable the
// Core Drawing Pad first (Settings → Core plugins) to avoid two Draw buttons.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ID = "drawing-pad-companion";
const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
const output = path.join(root, "dist-community", ID);
if (!process.env.npm_execpath) throw new Error("Run through npm: npm run build:community");
execFileSync(process.execPath, [process.env.npm_execpath, "run", "build"], { cwd: root, stdio: "inherit" });
for (const target of [path.join(root, "dist-community")]) {
  try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error("Refusing to write into a symlinked dist-community."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.cpSync(dist, path.join(output, "dist"), { recursive: true });
const manifestFile = path.join(output, "dist", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
Object.assign(manifest, { id: ID, name: "Drawing Pad (iPad companion)",
  description: "Drawing Pad with a live iPad / Apple Pencil companion. Disable the Core Drawing Pad before enabling this copy." });
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Community package ready: ${output}
Copy the whole "${ID}" folder into LearnHarness's Community plugins directory
(Settings → Community plugins shows the path), so that the result is
  <plugins directory>/${ID}/dist/manifest.json
then Refresh, disable Core "Drawing Pad", enable "Drawing Pad (iPad companion)" and restart LearnHarness.`);
