import assert from "node:assert/strict";
import { it } from "node:test";
import type { PluginFrontendContext, PluginNotification } from "learnharness-plugin-api";
import { Sheets, type SessionSheet } from "../src/state.ts";
import type { Stroke } from "../src/strokes.ts";
import { CompanionHost, diffStrokes } from "../src/companion/host.ts";
import { applyOp, type DocOp, type DocSnapshot, type WireStroke } from "../src/companion/protocol.ts";
import type { CompanionStatus } from "../src/companion/backend.ts";

const flush = async (times = 3) => { for (let i = 0; i < times; i++) await new Promise(resolve => setImmediate(resolve)); };
const stroke = (x = 10): Stroke => ({ tool: "pen", points: [{ x, y: 10, pressure: .5 }] });
const wire = (id: string, x = 20): WireStroke => ({ id, tool: "pen", size: 1, pts: [x, 20, .5, x + 5, 25, .5] });
const blank = { background: "", backgroundColor: "#141414", width: 0, height: 0, pixelRatio: 2 };
const status = (running: boolean): CompanionStatus => ({ running, port: 8765, addresses: [], devices: [] });

interface Call { name: string; value: unknown }
interface PublishInput { host: string; claim?: boolean; state?: DocSnapshot | null; op?: { t: "op"; doc: string; rev: number; op: DocOp; redo: number } }

function fixture(options: { running?: boolean; publish?: (input: PublishInput) => unknown | Promise<unknown> } = {}) {
  const notifications = new Set<(event: PluginNotification) => void>(), resyncs = new Set<() => void>();
  const calls: Call[] = [];
  let running = options.running ?? true;
  let publish = options.publish ?? (() => ({ ok: true }));
  const ctx = {
    manifest: { id: "drawing-pad" },
    async call(name: string, value: unknown) {
      calls.push({ name, value });
      if (name === "companion-status") return status(running);
      if (name === "companion-publish") return await publish(value as PublishInput);
      return { ok: true };
    },
    onNotification(fn: (event: PluginNotification) => void) { notifications.add(fn); return () => { notifications.delete(fn); }; },
    onResync(fn: () => void) { resyncs.add(fn); return () => { resyncs.delete(fn); }; },
  } as unknown as PluginFrontendContext;
  const sheets = new Sheets(() => {}, () => {});
  const host = new CompanionHost(ctx, sheets);
  const teaching = sheets.session("t", "teaching");
  return {
    ctx, sheets, host, calls, teaching,
    setRunning(value: boolean) { running = value; },
    setPublish(fn: typeof publish) { publish = fn; },
    notify(topic: string, data: unknown, pluginId = "drawing-pad") { for (const fn of notifications) fn({ pluginId, topic, data } as PluginNotification); },
    resync() { for (const fn of resyncs) fn(); },
    published(): PublishInput[] { return calls.filter(call => call.name === "companion-publish").map(call => call.value as PublishInput); },
    rejects(): Call[] { return calls.filter(call => call.name === "companion-reject"); },
    lastPublished(): PublishInput { const all = this.published(); assert.ok(all.length, "expected a publish"); return all.at(-1)!; },
  };
}
async function focused(kind: "teaching" | "practice" = "teaching", options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options);
  const state = kind === "teaching" ? f.teaching : f.sheets.session("p", "practice");
  f.sheets.create(state, blank);
  f.host.focus(state);
  await flush();
  return { ...f, state };
}
const opOf = (input: PublishInput) => { assert.ok(input.op, `expected an op, got ${JSON.stringify(input)}`); return input.op; };

it("diffStrokes classifies push, pop, same and reset by identity", () => {
  const a = stroke(1), b = stroke(2), c = stroke(3);
  assert.equal(diffStrokes([a, b], [a, b]), "same");
  assert.equal(diffStrokes([a], [a, b]), "push");
  assert.equal(diffStrokes([a, b], [a]), "pop");
  assert.equal(diffStrokes([a, b], [a, c]), "reset");
  assert.equal(diffStrokes([a], [{ ...a }]), "reset");
});

it("does not publish anything while the companion is not running", async () => {
  const f = fixture({ running: false });
  f.sheets.create(f.teaching, blank); f.host.focus(f.teaching); await flush();
  f.sheets.update(f.teaching, [stroke()]); await flush();
  assert.equal(f.host.running, false);
  assert.equal(f.published().length, 0);
  // Becoming running (status notification) publishes the full claimed state.
  f.notify("companion-status", status(true)); await flush();
  const first = f.lastPublished();
  assert.equal(first.claim, true); assert.equal(first.state!.strokes.length, 1);
  f.host.dispose();
});

it("focus with a draft publishes a full claimed snapshot, then push/pop/push/reset ops with rev+1", async () => {
  const f = await focused();
  try {
    assert.equal(f.published().length, 1);
    const first = f.lastPublished();
    assert.equal(first.host, f.host.instance); assert.equal(first.claim, true);
    const snap = first.state!;
    assert.equal(snap.id, f.host.docId()); assert.equal(snap.rev, 0); assert.equal(snap.kind, "teaching");
    assert.equal(snap.label, "Blank sheet"); assert.deepEqual(snap.strokes, []); assert.equal(snap.redo, 0); assert.equal(snap.mode, "dark");
    let mirror: WireStroke[] = snap.strokes;

    f.sheets.update(f.state, [stroke(10)]); await flush();
    let op = opOf(f.lastPublished());
    assert.equal(op.rev, 1); assert.equal(op.doc, snap.id); assert.equal(op.op.k, "push"); assert.equal(op.redo, 0);
    assert.equal(f.lastPublished().claim, undefined);
    mirror = applyOp(mirror, op.op);
    const desktopId = mirror[0]!.id;
    assert.match(desktopId, /^d[0-9a-f]{24}$/);

    f.sheets.undo(f.state); await flush();
    op = opOf(f.lastPublished());
    assert.deepEqual(op.op, { k: "pop" }); assert.equal(op.rev, 2); assert.equal(op.redo, 1);
    mirror = applyOp(mirror, op.op);

    f.sheets.redo(f.state); await flush();
    op = opOf(f.lastPublished());
    assert.equal(op.op.k, "push"); assert.equal(op.rev, 3); assert.equal(op.redo, 0);
    assert.equal(op.op.k === "push" && op.op.stroke.id, desktopId, "redone stroke keeps its sync id");
    mirror = applyOp(mirror, op.op);

    f.sheets.update(f.state, [...f.state.draft!.strokes, stroke(30)]); await flush();
    mirror = applyOp(mirror, opOf(f.lastPublished()).op);
    f.sheets.clear(f.state); await flush();
    op = opOf(f.lastPublished());
    assert.deepEqual(op.op, { k: "reset", strokes: [] }); assert.equal(op.rev, 5); assert.equal(op.redo, 0);
    assert.deepEqual(applyOp(mirror, op.op), []);
    // No change => no publish.
    const count = f.published().length;
    f.sheets.setPan(f.state, { x: 5, y: 5 }); await flush();
    assert.equal(f.published().length, count);
  } finally { f.host.dispose(); }
});

it("publishes are serialized: one call in flight at a time and revisions strictly increase", async () => {
  let inFlight = 0, maxInFlight = 0;
  const pending: (() => void)[] = [];
  const f = await focused("teaching", {
    publish: () => new Promise(resolve => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      pending.push(() => { inFlight--; resolve({ ok: true }); });
    }),
  });
  try {
    const release = async () => { while (pending.length) { pending.shift()!(); await flush(); } };
    await release(); // initial state
    f.sheets.update(f.state, [stroke(1)]); await flush();
    f.sheets.update(f.state, [...f.state.draft!.strokes, stroke(2)]);
    f.sheets.update(f.state, [...f.state.draft!.strokes, stroke(3)]);
    f.sheets.undo(f.state);
    await flush();
    assert.equal(pending.length, 1, "later changes wait for the in-flight publish");
    await release(); await release();
    assert.equal(maxInFlight, 1);
    const all = f.published();
    assert.ok(all[0]!.state);
    const revs = all.slice(1).map(input => opOf(input).rev);
    assert.deepEqual(revs, revs.map((_, i) => i + 1));
    // Replay all ops: the mirror equals the final sheet.
    let mirror = all[0]!.state!.strokes;
    for (const input of all.slice(1)) mirror = applyOp(mirror, opOf(input).op);
    assert.deepEqual(mirror.map(s => s.pts[0]), f.state.draft!.strokes.map(s => s.points[0]!.x));
    assert.equal(opOf(all.at(-1)!).redo, 1);
  } finally { f.host.dispose(); }
});

it("a backend {resync:true} answer triggers a fresh full state at the current rev", async () => {
  let resyncOnce = false;
  const f = await focused("teaching", { publish: () => { if (resyncOnce) { resyncOnce = false; return { resync: true }; } return { ok: true }; } });
  try {
    resyncOnce = true;
    f.sheets.update(f.state, [stroke()]); await flush();
    const all = f.published();
    assert.ok(all.at(-2)!.op);
    const last = all.at(-1)!;
    assert.ok(last.state, "resync answer is followed by a full state");
    assert.equal(last.state.rev, 1); assert.equal(last.state.strokes.length, 1); assert.equal(last.claim, undefined);
    // companion-need-state also forces a full state
    f.notify("companion-need-state", {}); await flush();
    assert.ok(f.lastPublished().state);
    // ctx resync forces a full state too
    const n = f.published().length;
    f.resync(); await flush();
    assert.ok(f.published().length > n); assert.ok(f.lastPublished().state);
  } finally { f.host.dispose(); }
});

it("companion stroke intent for the current doc is applied with its id preserved in the next push", async () => {
  const f = await focused();
  try {
    const doc = f.host.docId()!;
    f.notify("companion-intent", { device: "dev1", intent: { t: "stroke", doc, stroke: { ...wire("ipad1"), size: 2 } } }); await flush();
    const strokes = f.state.draft!.strokes;
    assert.equal(strokes.length, 1); assert.equal(strokes[0]!.id, "ipad1"); assert.equal(strokes[0]!.size, 2);
    assert.deepEqual(strokes[0]!.points, [{ x: 20, y: 20, pressure: .5 }, { x: 25, y: 25, pressure: .5 }]);
    const op = opOf(f.lastPublished());
    assert.equal(op.op.k, "push");
    assert.deepEqual(op.op.k === "push" && op.op.stroke, { ...wire("ipad1"), size: 2 });
    assert.equal(f.rejects().length, 0);
    // undo / redo / clear intents use the Sheets methods
    f.notify("companion-intent", { device: "dev1", intent: { t: "undo", doc } }); await flush();
    assert.equal(f.state.draft!.strokes.length, 0); assert.equal(f.sheets.canRedo(f.state), true);
    assert.deepEqual(opOf(f.lastPublished()).op, { k: "pop" });
    f.notify("companion-intent", { device: "dev1", intent: { t: "redo", doc } }); await flush();
    assert.equal(f.state.draft!.strokes[0]!.id, "ipad1");
    const redo = opOf(f.lastPublished()).op;
    assert.equal(redo.k === "push" && redo.stroke.id, "ipad1");
    f.notify("companion-intent", { device: "dev1", intent: { t: "clear", doc } }); await flush();
    assert.equal(f.state.draft!.strokes.length, 0); assert.equal(f.sheets.canRedo(f.state), false);
  } finally { f.host.dispose(); }
});

it("invalid stroke intents are dropped", async () => {
  const f = await focused();
  try {
    const doc = f.host.docId()!;
    for (const bad of [{ ...wire("x1"), id: "bad id!" }, { ...wire("x2"), tool: "laser" }, { ...wire("x3"), pts: [1, 2] }, { ...wire("x4"), pts: [1, 2, 5] }])
      f.notify("companion-intent", { device: "dev1", intent: { t: "stroke", doc, stroke: bad } });
    f.notify("companion-intent", { device: "dev1", intent: { t: "stroke", doc: "not a doc id!", stroke: wire("x5") } });
    await flush();
    assert.equal(f.state.draft!.strokes.length, 0);
  } finally { f.host.dispose(); }
});

it("a resent stroke id is ignored, even after undo or clear", async () => {
  const f = await focused();
  try {
    const doc = f.host.docId()!;
    const send = () => f.notify("companion-intent", { device: "dev1", intent: { t: "stroke", doc, stroke: wire("dup") } });
    send(); await flush();
    send(); await flush();
    assert.equal(f.state.draft!.strokes.length, 1);
    f.sheets.undo(f.state); send(); await flush();
    assert.equal(f.state.draft!.strokes.length, 0);
    f.sheets.redo(f.state); f.sheets.clear(f.state); send(); await flush();
    assert.equal(f.state.draft!.strokes.length, 0);
    // A duplicate of a stroke that was since removed is rejected, so the device drops
    // its pending copy instead of resending it forever.
    const rejects = f.calls.filter(call => call.name === "companion-reject").map(call => call.value as { id: string });
    assert.ok(rejects.length >= 1 && rejects.every(reject => reject.id === "dup"));
  } finally { f.host.dispose(); }
});

it("intent for this window's stale draft is rejected and not applied to the new sheet", async () => {
  const f = await focused();
  try {
    const old = f.host.docId()!;
    f.sheets.create(f.state, blank); await flush();
    const current = f.host.docId()!;
    assert.notEqual(old, current);
    f.notify("companion-intent", { device: "dev1", intent: { t: "stroke", doc: old, stroke: wire("late") } }); await flush();
    assert.equal(f.state.draft!.strokes.length, 0);
    assert.deepEqual(f.rejects().map(call => call.value), [{ host: f.host.instance, doc: old, id: "late", reason: "This drawing changed on the computer." }]);
    assert.ok(f.lastPublished().state, "the device is resynchronized");
    assert.equal(f.lastPublished().state!.id, current);
    // Undo/clear for a stale doc are not applied either (no reject: no stroke id).
    f.sheets.update(f.state, [stroke()]); await flush();
    f.notify("companion-intent", { device: "dev1", intent: { t: "clear", doc: old } }); await flush();
    assert.equal(f.state.draft!.strokes.length, 1); assert.equal(f.rejects().length, 1);
  } finally { f.host.dispose(); }
});

it("intent for another session after focus switched is not applied anywhere", async () => {
  const f = await focused();
  try {
    const oldDoc = f.host.docId()!;
    const other = f.sheets.session("t2", "teaching"); f.sheets.create(other, blank);
    f.host.focus(other); await flush();
    assert.equal(f.lastPublished().claim, true); assert.equal(f.lastPublished().state!.id, f.host.docId());
    f.notify("companion-intent", { device: "dev1", intent: { t: "stroke", doc: oldDoc, stroke: wire("s1") } }); await flush();
    assert.equal(other.draft!.strokes.length, 0);
    assert.equal(f.state.draft!.strokes.length, 0, "the previously focused session is not drawn into");
    assert.equal(f.rejects().length, 1);
    assert.equal((f.rejects()[0]!.value as { doc: string }).doc, oldDoc);
  } finally { f.host.dispose(); }
});

it("intents carrying another window's instance prefix are ignored silently", async () => {
  const f = await focused();
  try {
    const doc = f.host.docId()!;
    const foreign = `ffffffffffffffffffffffff${doc.slice(f.host.instance.length)}`;
    assert.notEqual(foreign, doc);
    const before = f.calls.length;
    f.notify("companion-intent", { device: "dev1", intent: { t: "stroke", doc: foreign, stroke: wire("f1") } });
    f.notify("companion-intent", { device: "dev1", intent: { t: "undo", doc: foreign } });
    await flush();
    assert.equal(f.state.draft!.strokes.length, 0);
    assert.equal(f.calls.length, before, "no reject and no republish");
    // Notifications from other plugins are ignored too.
    f.notify("companion-intent", { device: "dev1", intent: { t: "stroke", doc, stroke: wire("f2") } }, "other-plugin"); await flush();
    assert.equal(f.state.draft!.strokes.length, 0);
  } finally { f.host.dispose(); }
});

it("companion-live shows a live preview that is removed when the stroke commits", async () => {
  const f = await focused();
  try {
    const doc = f.host.docId()!;
    let liveEvents = 0; f.sheets.onLive(() => liveEvents++);
    f.notify("companion-live", { device: "dev1", message: { t: "live", doc, sid: "s1", tool: "pen", size: 2, from: 0, pts: [1, 2, .5, 3, 4, .6] } });
    let live = f.sheets.liveStrokes(f.state);
    assert.equal(live.length, 1);
    assert.deepEqual(live[0], { tool: "pen", size: 2, points: [{ x: 1, y: 2, pressure: .5 }, { x: 3, y: 4, pressure: .6 }] });
    // Continuation from index 1 replaces the tail.
    f.notify("companion-live", { device: "dev1", message: { t: "live", doc, sid: "s1", tool: "pen", size: 2, from: 1, pts: [5, 6, .7, 7, 8, .8] } });
    live = f.sheets.liveStrokes(f.state);
    assert.deepEqual(live[0]!.points.map(p => p.x), [1, 5, 7]);
    // Live strokes are never content.
    assert.equal(f.state.draft!.strokes.length, 0);
    // A message that missed the start is ignored.
    f.notify("companion-live", { device: "dev1", message: { t: "live", doc, sid: "s2", tool: "pen", size: 1, from: 3, pts: [1, 1, .5] } });
    assert.equal(f.sheets.liveStrokes(f.state).length, 1);
    // Live for a different doc is ignored.
    f.notify("companion-live", { device: "dev1", message: { t: "live", doc: `${doc}x`, sid: "s3", tool: "pen", size: 1, from: 0, pts: [1, 1, .5] } });
    assert.equal(f.sheets.liveStrokes(f.state).length, 1);
    f.notify("companion-intent", { device: "dev1", intent: { t: "stroke", doc, stroke: wire("s1") } }); await flush();
    assert.deepEqual(f.sheets.liveStrokes(f.state), []);
    assert.equal(f.state.draft!.strokes.length, 1);
    assert.ok(liveEvents >= 3);
  } finally { f.host.dispose(); }
});

it("live-end removes the preview; switching focus clears previews", async () => {
  const f = await focused();
  try {
    const doc = f.host.docId()!;
    const start = (sid: string, d = doc) => f.notify("companion-live", { device: "dev1", message: { t: "live", doc: d, sid, tool: "eraser", size: 1, from: 0, pts: [1, 1, .5] } });
    start("a1");
    assert.deepEqual(f.sheets.liveStrokes(f.state), [{ tool: "eraser", points: [{ x: 1, y: 1, pressure: .5 }] }]);
    f.notify("companion-live", { device: "dev1", message: { t: "live-end", doc, sid: "a1" } });
    assert.deepEqual(f.sheets.liveStrokes(f.state), []);
    start("a2"); start("a3");
    assert.equal(f.sheets.liveStrokes(f.state).length, 2);
    const other = f.sheets.session("t2", "teaching"); f.sheets.create(other, blank);
    f.host.focus(other); await flush();
    assert.deepEqual(f.sheets.liveStrokes(f.state), []);
    // Refocusing the same session keeps previews.
    start("b1", f.host.docId()!);
    f.host.focus(other);
    assert.equal(f.sheets.liveStrokes(other).length, 1);
  } finally { f.host.dispose(); }
});

it("teaching acceptance after an iPad stroke publishes a reset to an empty sheet", async () => {
  const f = await focused();
  try {
    const doc = f.host.docId()!;
    f.sheets.update(f.state, [stroke()]);
    f.notify("companion-intent", { device: "dev1", intent: { t: "stroke", doc, stroke: wire("ipad") } }); await flush();
    assert.equal(f.state.draft!.strokes.length, 2);
    const captured = f.sheets.capture(f.state)!;
    f.sheets.accepted(captured); await flush();
    assert.equal(f.state.draft!.strokes.length, 0);
    const op = opOf(f.lastPublished());
    assert.deepEqual(op.op, { k: "reset", strokes: [] }); assert.equal(op.redo, 0);
    // The accepted iPad stroke cannot be resent into the cleared sheet.
    f.notify("companion-intent", { device: "dev1", intent: { t: "stroke", doc, stroke: wire("ipad") } }); await flush();
    assert.equal(f.state.draft!.strokes.length, 0);
  } finally { f.host.dispose(); }
});

it("teaching acceptance of a single iPad stroke leaves the mirror empty", async () => {
  const f = await focused();
  try {
    const doc = f.host.docId()!;
    f.notify("companion-intent", { device: "dev1", intent: { t: "stroke", doc, stroke: wire("only") } }); await flush();
    let mirror = applyOp([], opOf(f.lastPublished()).op);
    f.sheets.accepted(f.sheets.capture(f.state)!); await flush();
    const op = opOf(f.lastPublished());
    mirror = applyOp(mirror, op.op);
    assert.deepEqual(mirror, []); assert.equal(op.redo, 0);
  } finally { f.host.dispose(); }
});

it("practice new-pose reset publishes state null, then a new sheet publishes a fresh snapshot", async () => {
  const f = await focused("practice");
  try {
    f.sheets.observePoses(f.state, ["p1"], true);
    f.sheets.update(f.state, [stroke()]); await flush();
    const n = f.published().length, oldDoc = f.host.docId()!;
    assert.equal(f.sheets.observePoses(f.state, ["p1", "p2"]), true); await flush();
    assert.equal(f.published().length, n + 1);
    assert.equal(f.lastPublished().state, null);
    assert.equal(f.host.docId(), undefined);
    // Stale intents for the vanished sheet are rejected, not applied.
    f.notify("companion-intent", { device: "dev1", intent: { t: "stroke", doc: oldDoc, stroke: wire("gone") } }); await flush();
    assert.equal(f.state.draft, undefined); assert.equal(f.rejects().length, 1);
    f.sheets.create(f.state, blank); await flush();
    const snap = f.lastPublished().state!;
    assert.equal(snap.kind, "practice"); assert.equal(snap.rev, 0); assert.deepEqual(snap.strokes, []);
  } finally { f.host.dispose(); }
});

it("stopping the companion drops published state; restart republishes a full snapshot", async () => {
  const f = await focused();
  try {
    f.sheets.update(f.state, [stroke()]); await flush();
    f.notify("companion-status", status(false)); await flush();
    const n = f.published().length;
    f.sheets.update(f.state, [...f.state.draft!.strokes, stroke(2)]); await flush();
    assert.equal(f.published().length, n);
    f.notify("companion-status", status(true)); await flush();
    const last = f.lastPublished();
    assert.ok(last.state); assert.equal(last.state.strokes.length, 2); assert.equal(last.state.rev, 0);
  } finally { f.host.dispose(); }
});

it("dispose stops publishing and ignores later notifications", async () => {
  const f = await focused();
  f.host.dispose();
  const n = f.calls.length;
  f.sheets.update(f.state, [stroke()]);
  f.notify("companion-need-state", {});
  await flush();
  assert.equal(f.calls.length, n);
});

// ---- review regressions -------------------------------------------------------
it("a stale 'ignored' reply does not make a window passive after it claimed (claim survives)", async () => {
  let release: (() => void) | undefined;
  const f = await focused("teaching", {});
  try {
    // An in-flight publish that will be answered "ignored" (another window owned it).
    f.setPublish(() => new Promise(resolve => { release = () => resolve({ ignored: true }); }));
    f.sheets.update(f.state, [stroke()]); await flush();
    f.setPublish(() => ({ ok: true }));
    const other = f.sheets.session("t2", "teaching"); f.sheets.create(other, blank);
    f.host.focus(other);            // user opens Draw here meanwhile
    release!(); await flush(6);
    f.sheets.update(other, [stroke(50)]); await flush(6);
    const last = f.lastPublished();
    assert.ok(last.op?.op.k === "push" || last.state, "the window keeps publishing after its claim");
  } finally { f.host.dispose(); }
});
it("a failed claim publish keeps the claim for the retry", async () => {
  let fail = true;
  const f = fixture({ publish: () => { if (fail) { fail = false; throw new Error("transient"); } return { ok: true }; } });
  try {
    f.sheets.create(f.teaching, blank); f.host.focus(f.teaching); await flush();
    f.notify("companion-need-state", undefined); await flush();
    const claims = f.published().filter(input => input.claim);
    assert.equal(claims.length, 2, "the retry still carries claim:true");
  } finally { f.host.dispose(); }
});
it("live previews are capped per device and scoped by device", async () => {
  const f = await focused();
  try {
    const doc = f.host.docId()!;
    const live = (device: string, sid: string) => f.notify("companion-live", { device, message: { t: "live", doc, sid, tool: "pen", size: 1, from: 0, pts: [1, 1, .5] } });
    for (const sid of ["s1", "s2", "s3", "s4"]) live("devA", sid);
    live("devB", "s1");
    assert.equal(f.sheets.liveStrokes(f.state).length, 3, "two for devA (newest) + one for devB");
    // devA ending its own s1 must not remove devB's s1.
    f.notify("companion-live", { device: "devA", message: { t: "live-end", doc, sid: "s1" } });
    assert.equal(f.sheets.liveStrokes(f.state).length, 3);
    f.notify("companion-live", { device: "devB", message: { t: "live-end", doc: "other.doc.9", sid: "s1" } });
    assert.equal(f.sheets.liveStrokes(f.state).length, 2, "live-end works even for an older sheet id");
  } finally { f.host.dispose(); }
});
it("dispose releases ownership", async () => {
  const f = await focused();
  f.host.dispose(); await flush();
  assert.ok(f.published().some(input => (input as { release?: boolean }).release === true));
});
