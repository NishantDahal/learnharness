import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activateCompanion, OWNER_TIMEOUT_MS } from "../src/companion/backend.ts";
import { Sheets } from "../src/state.ts";
import { activate } from "../src/backend.ts";
import type { DocSnapshot } from "../src/companion/protocol.ts";

/** Drives the backend's ownership rules through its ctx.handle operations. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-owner-"));
  fs.mkdirSync(path.join(root, "code", "companion"), { recursive: true });
  for (const file of ["index.html", "app.js", "app.css"]) fs.writeFileSync(path.join(root, "code", "companion", file), "x");
  const handlers = new Map<string, (input: unknown) => unknown>(), events: { topic: string; data: unknown }[] = [];
  const clock = { now: 1_000_000 };
  const controller = new AbortController();
  const ctx = { directory: path.join(root, "code"), dataDirectory: path.join(root, "data"), signal: controller.signal,
    handle(name: string, fn: (input: unknown) => unknown) { handlers.set(name, fn); return () => handlers.delete(name); },
    events: { emit(topic: string, data: unknown) { events.push({ topic, data }); } } } as unknown as PluginBackendContext;
  const dispose = activateCompanion(ctx, { host: "127.0.0.1", interfaces: () => ({}), now: () => clock.now });
  const call = (name: string, input?: unknown) => handlers.get(name)!(input);
  const doc = (host: string, rev = 0): DocSnapshot => ({ id: `${host}.chat_a.1`, rev, kind: "teaching", label: "Blank sheet", width: 0, height: 0,
    background: "", backgroundColor: "#fff", mode: "dark", strokes: [], redo: 0 });
  return { call, events, clock, doc, async close() { await dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const op = (host: string, rev: number) => ({ t: "op", doc: `${host}.chat_a.1`, rev, op: { k: "pop" }, redo: 0 });

it("an op before any owner asks for a full state instead of making the window passive", async () => {
  const f = fixture();
  try { assert.deepEqual(f.call("companion-publish", { host: "hostA", op: op("hostA", 1) }), { resync: true }); }
  finally { await f.close(); }
});
it("only a claim moves ownership away from a live owner; release frees it", async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.call("companion-publish", { host: "hostA", state: f.doc("hostA"), claim: true }), { ok: true });
    assert.deepEqual(f.call("companion-publish", { host: "hostB", state: f.doc("hostB") }), { ignored: true });
    assert.deepEqual(f.call("companion-publish", { host: "hostB", state: f.doc("hostB"), claim: true }), { ok: true });
    assert.deepEqual(f.call("companion-publish", { host: "hostA", op: op("hostA", 1) }), { ignored: true });
    f.call("companion-publish", { host: "hostB", release: true });
    assert.deepEqual(f.call("companion-publish", { host: "hostA", state: f.doc("hostA") }), { ok: true }, "anyone may take a released sheet");
  } finally { await f.close(); }
});
it("an owner that stops reporting liveness loses the sheet; alive pings keep it", async () => {
  const f = fixture();
  try {
    f.call("companion-publish", { host: "hostA", state: f.doc("hostA"), claim: true });
    f.clock.now += OWNER_TIMEOUT_MS - 1000;
    assert.deepEqual(f.call("companion-alive", { host: "hostA" }), { ok: true });
    f.clock.now += OWNER_TIMEOUT_MS - 1000;
    assert.deepEqual(f.call("companion-publish", { host: "hostB", state: f.doc("hostB") }), { ignored: true }, "still alive");
    f.clock.now += OWNER_TIMEOUT_MS + 1;
    assert.deepEqual(f.call("companion-publish", { host: "hostB", state: f.doc("hostB") }), { ok: true }, "a stale owner can be replaced");
  } finally { await f.close(); }
});
it("redo-only sheets are kept when the pad closes (dropUntouched)", () => {
  const sheets = new Sheets(() => {}, () => {}), state = sheets.session("s", "teaching");
  sheets.create(state, { background: "", backgroundColor: "#000", width: 0, height: 0, pixelRatio: 1 });
  sheets.update(state, [{ tool: "pen", points: [{ x: 1, y: 1, pressure: .5 }] }]);
  sheets.undo(state);
  sheets.dropUntouched(state);
  assert.ok(state.draft, "kept for Redo");
  sheets.redo(state);
  assert.equal(state.draft!.strokes.length, 1);
  sheets.clear(state); sheets.dropUntouched(state);
  assert.equal(state.draft, undefined, "a cleared sheet is untouched again");
});
it("the most recent Draw claim owns the sheet; an older claim or stale republish cannot steal it", async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.call("companion-publish", { host: "hostA", state: f.doc("hostA"), claim: true, claimedAt: 200 }), { ok: true });
    assert.deepEqual(f.call("companion-publish", { host: "hostB", state: f.doc("hostB"), claim: true, claimedAt: 100 }), { ignored: true });
    assert.deepEqual(f.call("companion-publish", { host: "hostB", state: f.doc("hostB"), claimedAt: 150 }), { ignored: true });
    assert.deepEqual(f.call("companion-publish", { host: "hostB", state: f.doc("hostB"), claimedAt: 250 }), { ok: true }, "a newer claim wins");
  } finally { await f.close(); }
});
it("a corrupt companion file never disables the Drawing Pad backend", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-corrupt-"));
  const data = path.join(root, "data"); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "companion.json"), "{not json");
  const handlers = new Map<string, (input: unknown) => unknown>();
  const ctx = { directory: root, dataDirectory: data, signal: new AbortController().signal,
    handle(name: string, fn: (input: unknown) => unknown) { handlers.set(name, fn); return () => handlers.delete(name); },
    events: { emit() {} }, learning: { getSession() { return null; } } } as unknown as PluginBackendContext;
  const error = console.error; console.error = () => {};
  try {
    const dispose = activate(ctx);
    assert.ok(handlers.has("get-settings"), "core operations still registered");
    assert.ok(!handlers.has("companion-start"), "only the companion is unavailable");
    void dispose();
  } finally { console.error = error; fs.rmSync(root, { recursive: true, force: true }); }
});
