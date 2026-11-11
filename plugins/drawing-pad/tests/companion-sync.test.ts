/** End-to-end companion sync without a browser: the real backend relay (LAN server on
 * 127.0.0.1), the real desktop CompanionHost + Sheets, and a simulated iPad built from
 * the page's DOM-free CompanionConnection + CompanionDocument over a real WebSocket. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { PluginBackendContext, PluginFrontendContext, PluginNotification } from "learnharness-plugin-api";
import { activateCompanion, type CompanionStatus, type PairingInfo } from "../src/companion/backend.ts";
import { CompanionHost, randomId } from "../src/companion/host.ts";
import { toWire, type WireStroke } from "../src/companion/protocol.ts";
import { CompanionConnection, TOKEN_KEY, type ConnectionState, type SocketLike, type StorageLike } from "../src/companion/page/connection.ts";
import { CompanionDocument } from "../src/companion/page/document.ts";
import { Sheets, type SessionSheet } from "../src/state.ts";
import { visibleStrokes, type Point, type Stroke } from "../src/strokes.ts";

const TIMEOUT = 8_000;
const roundTrip = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;

async function waitFor(condition: () => boolean, label: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const pts = (...xy: [number, number][]): Point[] => xy.map(([x, y]) => ({ x, y, pressure: 0.5 }));

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

/** Mirrors the glue in src/companion/page/app.ts (onState / op / reject handlers). */
class FakeIPad {
  readonly model = new CompanionDocument();
  readonly sockets: WebSocket[] = [];
  readonly statuses: { state: ConnectionState; detail?: string }[] = [];
  readonly rejects: { id: string; reason: string }[] = [];
  readonly closes: number[] = [];
  states = 0;
  readonly connection: CompanionConnection;
  constructor(port: number, readonly storage: StorageLike, pairCode?: string) {
    const origin = `http://127.0.0.1:${port}`;
    this.connection = new CompanionConnection({
      url: `ws://127.0.0.1:${port}/ws`, storage, name: "Test iPad", ...(pairCode ? { pairCode } : {}),
      createSocket: url => {
        const socket = new WebSocket(url, { origin });
        socket.on("close", code => this.closes.push(code));
        this.sockets.push(socket);
        return socket as unknown as SocketLike;
      },
    }, {
      state: (doc, host) => {
        this.states++;
        const { resend } = this.model.applyState(doc, host);
        for (const wire of resend) this.connection.send({ t: "stroke", doc: doc!.id, stroke: wire });
      },
      op: message => { if (this.model.applyOp(message) === "resync") this.connection.send({ t: "sync" }); },
      reject: (id, reason) => { this.rejects.push({ id, reason }); this.model.reject(id); },
      status: (state, detail) => { this.statuses.push({ state, ...(detail ? { detail } : {}) }); },
    });
  }
  /** Finishes a stroke the way app.ts does: pending first, then (if online) sent. */
  draw(points: Point[], tool: Stroke["tool"] = "pen", size = 1): { wire: WireStroke; sent: boolean } {
    const doc = this.model.doc;
    assert.ok(doc, "iPad has no document to draw on");
    const wire = toWire({ tool, points, size }, randomId());
    this.model.addPending(wire);
    return { wire, sent: this.connection.send({ t: "stroke", doc: doc.id, stroke: wire }) };
  }
  stop(): void { this.connection.stop(); for (const socket of this.sockets) socket.terminate(); }
}

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawing-pad-companion-"));
  const directory = path.join(root, "plugin"), dataDirectory = path.join(root, "data");
  fs.mkdirSync(path.join(directory, "companion"), { recursive: true });
  fs.writeFileSync(path.join(directory, "companion", "index.html"), "<!doctype html><title>Companion stub</title>");
  fs.writeFileSync(path.join(directory, "companion", "app.js"), "// stub");
  fs.writeFileSync(path.join(directory, "companion", "app.css"), "/* stub */");

  const handlers = new Map<string, (input: unknown) => unknown>();
  const listeners = new Set<(event: PluginNotification) => void>();
  const emitted: { topic: string; data: unknown }[] = [];
  const backendCtx = {
    directory, dataDirectory, signal: new AbortController().signal,
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
    events: {
      emit(topic: string, data: unknown) {
        emitted.push({ topic, data });
        const copy = roundTrip(data); // the real bridge serializes notifications
        setImmediate(() => { for (const listener of listeners) listener({ pluginId: "drawing-pad", topic, data: copy }); });
      },
    },
  } as unknown as PluginBackendContext;
  const stopBackend = activateCompanion(backendCtx, {
    host: "127.0.0.1",
    interfaces: () => ({ test0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "127.0.0.1/8" }] }),
  });
  const calls: string[] = [];
  const frontendCtx = {
    manifest: { id: "drawing-pad" }, signal: new AbortController().signal,
    async call(name: string, input?: unknown) {
      calls.push(name);
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No backend operation ${name}`);
      return roundTrip(await handler(roundTrip(input))); // mimic the HTTP bridge
    },
    onNotification(fn: (event: PluginNotification) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onResync() { return () => {}; },
  } as unknown as PluginFrontendContext;
  const sheets = new Sheets(() => {}, () => {});
  const host = new CompanionHost(frontendCtx, sheets);
  const ipads: FakeIPad[] = [];
  let port = 0;

  const f = {
    root, dataDirectory, sheets, host, emitted, calls, ipads,
    get port() { return port; },
    async start(): Promise<CompanionStatus> {
      let last: unknown;
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = 20_000 + Math.floor(Math.random() * 40_000);
        try {
          const status = await host.call<CompanionStatus>("companion-start", { port: candidate });
          port = candidate;
          return status;
        } catch (error) { last = error; }
      }
      throw last;
    },
    async pair(): Promise<string> {
      const info = await host.call<PairingInfo>("companion-pair");
      const link = info.links[0];
      assert.ok(link, "pairing returned no link");
      const url = new URL(link.url);
      assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, String(port));
      const code = new URLSearchParams(url.hash.slice(1)).get("pair");
      assert.ok(code, "pairing link has no code");
      return code;
    },
    ipad(storage: StorageLike = new MemoryStorage(), pairCode?: string): FakeIPad {
      const ipad = new FakeIPad(port, storage, pairCode);
      ipads.push(ipad);
      return ipad;
    },
    async pairedIPad(): Promise<FakeIPad> {
      const ipad = f.ipad(new MemoryStorage(), await f.pair());
      ipad.connection.connect();
      await waitFor(() => ipad.connection.online, "iPad online");
      return ipad;
    },
    sheet(id: string): SessionSheet {
      const state = sheets.session(id, "teaching");
      sheets.create(state, { background: "", backgroundColor: "#fff", width: 0, height: 0, pixelRatio: 1 });
      return state;
    },
    async focus(state: SessionSheet, ipad?: FakeIPad): Promise<string> {
      host.focus(state);
      const doc = host.docId(state);
      assert.ok(doc);
      if (ipad) await waitFor(() => ipad.model.doc?.id === doc, `iPad shows ${doc}`);
      return doc;
    },
    async close() {
      for (const ipad of ipads) ipad.stop();
      host.dispose();
      await stopBackend();
      sheets.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return f;
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function connected(): Promise<{ f: Fixture; ipad: FakeIPad; state: SessionSheet; doc: string }> {
  const f = await setup();
  try {
    await f.start();
    const ipad = await f.pairedIPad();
    const state = f.sheet("session-1");
    const doc = await f.focus(state, ipad);
    return { f, ipad, state, doc };
  } catch (error) { await f.close(); throw error; }
}
const strokes = (state: SessionSheet) => state.draft?.strokes ?? [];

// "E = mc^2" written as separate strokes on the iPad.
const E_STROKES = [
  pts([0, 0], [0, 40]), pts([0, 0], [20, 0]), pts([0, 20], [15, 20]), pts([0, 40], [20, 40]), // E
  pts([35, 15], [55, 15]), pts([35, 25], [55, 25]), // =
  pts([70, 40], [70, 25], [78, 20.5], [86, 25], [86, 40]), pts([86, 25], [94, 20.25], [102, 25], [102, 40]), // m
  pts([130, 22], [118, 22.75], [118, 38], [130, 38]), // c
  pts([136, 2], [142, -2], [146, 4], [136, 14], [148, 14]), // ^2
];

it("serves the companion page and syncs strokes, desktop erasing, undo/redo/clear both ways", { timeout: TIMEOUT }, async () => {
  const { f, ipad, state, doc } = await connected();
  try {
    // The LAN page is served from the plugin build directory, with the Host guard on.
    const page = await fetch(`http://127.0.0.1:${f.port}/`);
    assert.equal(page.status, 200); assert.match(await page.text(), /Companion stub/);
    assert.equal(ipad.model.host, true); assert.deepEqual(ipad.model.committedStrokes(), []);

    // Live preview: an in-progress iPad stroke shows on the desktop only as a live stroke.
    ipad.connection.send({ t: "live", doc, sid: "live1", tool: "pen", size: 1, from: 0, pts: [1, 2, 0.5, 3, 4, 0.5] });
    await waitFor(() => f.sheets.liveStrokes(state).length === 1, "desktop live preview");
    assert.deepEqual(f.sheets.liveStrokes(state)[0]!.points, pts([1, 2], [3, 4]));
    assert.equal(strokes(state).length, 0);
    ipad.connection.send({ t: "live-end", doc, sid: "live1" });
    await waitFor(() => f.sheets.liveStrokes(state).length === 0, "live preview removed");

    const wires: WireStroke[] = [];
    for (const points of E_STROKES) wires.push(ipad.draw(points).wire);
    await waitFor(() => strokes(state).length === E_STROKES.length && ipad.model.pending.length === 0, "all iPad strokes committed");
    assert.deepEqual(strokes(state).map(stroke => stroke.points), E_STROKES);
    assert.deepEqual(strokes(state).map(stroke => stroke.id), wires.map(wire => wire.id));
    assert.ok(strokes(state).every(stroke => stroke.tool === "pen" && stroke.size === undefined));
    assert.deepEqual(ipad.model.committedStrokes().map(stroke => stroke.points), E_STROKES);
    assert.equal(ipad.model.rev, E_STROKES.length);

    // Existing submission path: the desktop sheet now carries image content.
    const capture = f.sheets.capture(state);
    assert.ok(capture); assert.equal(capture.sendImage, true); assert.notEqual(capture.signature, "");

    // A different brush size round-trips too.
    const big = ipad.draw(pts([200, 200], [210, 210]), "pen", 4).wire;
    await waitFor(() => strokes(state).length === E_STROKES.length + 1 && ipad.model.pending.length === 0, "size-4 stroke");
    assert.equal(strokes(state).at(-1)!.size, 4); assert.equal(strokes(state).at(-1)!.id, big.id);

    // Desktop erases the "=" with an eraser stroke; the iPad mirror reflects it.
    const before = strokes(state).length;
    const eraser: Stroke = { tool: "eraser", points: pts([45, 10], [45, 30]) };
    f.sheets.update(state, [...strokes(state), eraser]);
    await waitFor(() => ipad.model.committedStrokes().length === before + 1, "eraser mirrored");
    const mirrored = ipad.model.committedStrokes().at(-1)!;
    assert.equal(mirrored.tool, "eraser"); assert.deepEqual(mirrored.points, eraser.points);
    assert.equal(visibleStrokes(ipad.model.committedStrokes()).length, before - 2);
    assert.equal(visibleStrokes(strokes(state)).length, before - 2);

    // iPad Undo removes the desktop eraser; Redo restores the very same stroke.
    ipad.connection.send({ t: "undo", doc });
    await waitFor(() => strokes(state).length === before && ipad.model.committedStrokes().length === before, "undo");
    assert.equal(ipad.model.redo, 1); assert.equal(f.sheets.canRedo(state), true);
    assert.equal(visibleStrokes(ipad.model.committedStrokes()).length, before);
    ipad.connection.send({ t: "redo", doc });
    await waitFor(() => strokes(state).length === before + 1 && ipad.model.committedStrokes().length === before + 1, "redo");
    assert.equal(strokes(state).at(-1), eraser); assert.equal(ipad.model.redo, 0);
    assert.equal(ipad.model.committedStrokes().at(-1)!.id, ipad.model.doc!.strokes.at(-1)!.id);

    // Desktop Undo also propagates (pop op).
    f.sheets.undo(state);
    await waitFor(() => ipad.model.committedStrokes().length === before && ipad.model.redo === 1, "desktop undo mirrored");

    // iPad Clear empties both and discards Redo.
    ipad.connection.send({ t: "clear", doc });
    await waitFor(() => strokes(state).length === 0 && ipad.model.committedStrokes().length === 0, "clear");
    assert.equal(ipad.model.redo, 0); assert.equal(f.sheets.canRedo(state), false);
    assert.equal(f.sheets.capture(state)!.sendImage, false);
    assert.deepEqual(ipad.rejects, []);
    // Server mirror and iPad stayed in lockstep the whole time (no resync was needed).
    assert.equal(ipad.states, 1);
  } finally { await f.close(); }
});

it("reconnection delivers pending strokes exactly once and never duplicates resent strokes", { timeout: TIMEOUT }, async () => {
  const { f, ipad, state, doc } = await connected();
  try {
    const a = ipad.draw(pts([0, 0], [10, 10])).wire;
    await waitFor(() => strokes(state).length === 1 && ipad.model.pending.length === 0, "stroke A");

    // Socket drops mid-session (Wi-Fi blip).
    ipad.sockets.at(-1)!.close();
    await waitFor(() => ipad.connection.state === "offline", "iPad offline");
    const b = ipad.draw(pts([20, 0], [30, 10]));
    assert.equal(b.sent, false, "offline stroke must not be sent");
    assert.equal(ipad.model.pending.length, 1);
    // The desktop keeps drawing while the iPad is away.
    const desktop: Stroke = { tool: "pen", points: pts([50, 50], [60, 60]) };
    f.sheets.update(state, [...strokes(state), desktop]);

    // Automatic reconnect (backoff), snapshot, then the pending stroke is resent.
    await waitFor(() => ipad.connection.online && ipad.model.pending.length === 0 && strokes(state).length === 3, "reconnected and synced");
    assert.ok(ipad.sockets.length >= 2);
    assert.deepEqual(strokes(state).map(stroke => stroke.id).filter(id => id === b.wire.id), [b.wire.id]);
    assert.deepEqual(strokes(state).map(stroke => stroke.points), [pts([0, 0], [10, 10]), desktop.points, pts([20, 0], [30, 10])]);
    assert.deepEqual(ipad.model.committedStrokes().map(stroke => stroke.points), strokes(state).map(stroke => stroke.points));

    // Stroke sent right before the socket dies (its push may never reach the iPad).
    const c = ipad.draw(pts([70, 0], [80, 10]));
    assert.equal(c.sent, true);
    ipad.sockets.at(-1)!.close();
    await waitFor(() => ipad.connection.state === "offline", "iPad offline again");
    await waitFor(() => ipad.connection.online && ipad.model.pending.length === 0, "reconnected after C");
    await waitFor(() => ipad.model.committedStrokes().length === strokes(state).length, "mirror caught up");
    assert.equal(strokes(state).filter(stroke => stroke.id === c.wire.id).length, 1);
    assert.equal(strokes(state).length, 4);

    // An explicit duplicate of a stroke still on the sheet (ack lost, resent) is ignored.
    ipad.connection.send({ t: "stroke", doc, stroke: b.wire });
    ipad.connection.send({ t: "sync" });
    const states = ipad.states;
    await waitFor(() => ipad.states > states, "state after sync");
    assert.equal(strokes(state).length, 4);
    assert.equal(strokes(state).filter(stroke => stroke.id === b.wire.id).length, 1);
    assert.deepEqual(ipad.rejects, []);

    // After Undo removed it, a late resend never brings a stroke back; it is rejected
    // so the iPad drops its copy instead of resending it on every reconnect.
    ipad.connection.send({ t: "undo", doc });
    await waitFor(() => strokes(state).length === 3 && ipad.model.committedStrokes().length === 3, "undo C");
    ipad.connection.send({ t: "stroke", doc, stroke: c.wire });
    await waitFor(() => ipad.rejects.length === 1, "late resend rejected");
    assert.equal(strokes(state).length, 3);
    assert.equal(ipad.model.committedStrokes().length, 3);
    assert.ok(!strokes(state).some(stroke => stroke.id === c.wire.id));
    assert.ok(strokes(state).some(stroke => stroke.id === a.id));
  } finally { await f.close(); }
});

it("isolates sessions: stale-doc strokes are rejected and never land on the new sheet", { timeout: TIMEOUT }, async () => {
  const { f, ipad, state, doc } = await connected();
  try {
    ipad.draw(pts([0, 0], [5, 5]));
    await waitFor(() => strokes(state).length === 1 && ipad.model.pending.length === 0, "stroke on session 1");

    const second = f.sheet("session-2");
    const doc2 = await f.focus(second, ipad);
    assert.notEqual(doc2, doc);
    assert.deepEqual(ipad.model.committedStrokes(), []);

    // A device still drawing on the old sheet is refused, not redirected.
    const stale = toWire({ tool: "pen", points: pts([9, 9], [10, 10]) }, randomId());
    ipad.connection.send({ t: "stroke", doc, stroke: stale });
    await waitFor(() => ipad.rejects.length === 1, "stale stroke rejected");
    assert.equal(ipad.rejects[0]!.id, stale.id);
    assert.deepEqual(strokes(second), []);
    assert.equal(strokes(state).length, 1);
    // Undo/clear aimed at the old sheet do nothing to either sheet.
    ipad.connection.send({ t: "clear", doc });
    ipad.connection.send({ t: "undo", doc });
    // Round trip something valid afterwards so the stale intents have been processed.
    ipad.draw(pts([1, 1], [2, 2]));
    await waitFor(() => strokes(second).length === 1 && ipad.model.pending.length === 0, "valid stroke on session 2");
    assert.equal(strokes(state).length, 1);

    // Pending strokes drawn offline for a sheet the desktop since replaced are dropped.
    ipad.sockets.at(-1)!.close();
    await waitFor(() => ipad.connection.state === "offline", "offline");
    ipad.draw(pts([3, 3], [4, 4]));
    const third = f.sheet("session-3");
    const doc3 = await f.focus(third);
    await waitFor(() => ipad.connection.online && ipad.model.doc?.id === doc3, "reconnected to session 3");
    assert.equal(ipad.model.takeDropped(), 1);
    assert.equal(ipad.model.pending.length, 0);
    assert.deepEqual(strokes(third), []);
    assert.equal(strokes(second).length, 1);
    assert.equal(strokes(state).length, 1);
  } finally { await f.close(); }
});

it("persists pairing as hashes only, rejects reused codes, and companion-stop disconnects the iPad", { timeout: TIMEOUT }, async () => {
  const f = await setup();
  try {
    await f.start();
    const code = await f.pair();
    const storage = new MemoryStorage();
    const ipad = f.ipad(storage, code);
    ipad.connection.connect();
    await waitFor(() => ipad.connection.online, "paired iPad online");
    const token = storage.getItem(TOKEN_KEY);
    assert.ok(token);

    const file = path.join(f.dataDirectory, "companion-devices.json"), text = fs.readFileSync(file, "utf8");
    assert.ok(!text.includes(token), "raw device token must not be persisted");
    assert.ok(!text.includes(code), "pairing code must not be persisted");
    const saved = JSON.parse(text) as { version: number; devices: { id: string; name: string; hash: string }[] };
    assert.equal(saved.version, 1); assert.equal(saved.devices.length, 1);
    assert.equal(saved.devices[0]!.hash, createHash("sha256").update(token).digest("hex"));
    assert.equal(saved.devices[0]!.name, "Test iPad");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dataDirectory, "companion.json"), "utf8")), { version: 1, enabled: true, port: f.port });
    await waitFor(() => f.host.connectedDevices === 1, "desktop sees the device");

    // The single-use code cannot pair a second device.
    const thief = f.ipad(new MemoryStorage(), code);
    thief.connection.connect();
    await waitFor(() => thief.connection.state === "denied", "reused code denied");
    // A stored token survives a reconnect from a fresh page load (no pair code).
    const reload = f.ipad(new MemoryStorage());
    reload.storage.setItem(TOKEN_KEY, token);
    reload.connection.connect();
    await waitFor(() => reload.connection.online, "token reconnect");
    reload.stop();

    const status = await f.host.call<CompanionStatus>("companion-stop");
    assert.equal(status.running, false);
    await waitFor(() => ipad.connection.state !== "online" && ipad.closes.length > 0, "iPad disconnected by stop");
    assert.equal(f.host.running, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDirectory, "companion.json"), "utf8")).enabled, false);
    // Stopping keeps the pairing (no token leaked on the way out either).
    assert.ok(!fs.readFileSync(file, "utf8").includes(token));
    assert.equal(storage.getItem(TOKEN_KEY), token);
  } finally { await f.close(); }
});

it("revoking a device closes its socket and makes the iPad forget its token", { timeout: TIMEOUT }, async () => {
  const { f, ipad } = await connected();
  try {
    const status = await f.host.call<CompanionStatus>("companion-status");
    const device = status.devices[0];
    assert.ok(device); assert.equal(device.connected, true);
    await f.host.call("companion-revoke", { deviceId: device.id });
    await waitFor(() => ipad.connection.state === "denied", "revoked iPad denied");
    assert.ok(ipad.closes.includes(4001));
    assert.equal(ipad.storage.getItem(TOKEN_KEY), null);
    assert.equal(fs.readFileSync(path.join(f.dataDirectory, "companion-devices.json"), "utf8").includes(device.id), false);
  } finally { await f.close(); }
});
