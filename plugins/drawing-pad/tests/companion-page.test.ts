import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CompanionDocument } from "../src/companion/page/document.ts";
import { CompanionConnection, TOKEN_KEY, type ConnectionHandlers, type ConnectionState, type SocketLike, type StorageLike } from "../src/companion/page/connection.ts";
import { PROTOCOL_VERSION, type DocSnapshot, type OpMessage, type WireStroke } from "../src/companion/protocol.ts";

// ---------- fixtures ----------
const wire = (id: string, x = 1): WireStroke => ({ id, tool: "pen", size: 1, pts: [x, 2, 0.5] });
const snapshot = (id = "doc-a", strokes: WireStroke[] = [], rev = strokes.length, redo = 0): DocSnapshot => ({
  id, rev, kind: "practice", label: "Blank sheet", width: 0, height: 0, background: "", backgroundColor: "#141414",
  mode: "dark", strokes, redo,
});
const op = (doc: string, rev: number, o: OpMessage["op"], redo = 0): OpMessage => ({ t: "op", doc, rev, op: o, redo });

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | undefined;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  receive(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  serverClose(code: number, reason = ""): void { this.readyState = 3; this.onclose?.({ code, reason }); }
}
class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}
class FakeClock {
  time = 0;
  private seq = 0;
  timers = new Map<number, { fn: () => void; at: number; ms: number }>();
  setTimer = (fn: () => void, ms: number): unknown => { const id = ++this.seq; this.timers.set(id, { fn, at: this.time + ms, ms }); return id; };
  clearTimer = (id: unknown): void => { if (typeof id === "number") this.timers.delete(id); };
  now = (): number => this.time;
  /** Delays of currently scheduled timers. */
  pending(): number[] { return [...this.timers.values()].map(timer => timer.ms); }
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let next: [number, { fn: () => void; at: number }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.timers.delete(next[0]); this.time = next[1].at; next[1].fn();
    }
    this.time = end;
  }
}
function setup(options: { pairCode?: string; token?: string } = {}) {
  const storage = new MemoryStorage();
  if (options.token) storage.setItem(TOKEN_KEY, options.token);
  const clock = new FakeClock(), sockets: FakeSocket[] = [];
  const statuses: { state: ConnectionState; detail?: string }[] = [];
  const states: { doc: DocSnapshot | null; host: boolean }[] = [], ops: OpMessage[] = [], rejects: [string, string][] = [];
  const handlers: ConnectionHandlers = {
    state: (doc, host) => { states.push({ doc, host }); },
    op: message => { ops.push(message); },
    reject: (id, reason) => { rejects.push([id, reason]); },
    status: (state, detail) => { statuses.push({ state, detail }); },
  };
  const connection = new CompanionConnection({
    url: "ws://host/companion", storage, createSocket: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    ...(options.pairCode ? { pairCode: options.pairCode } : {}), name: "Test iPad",
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
  }, handlers);
  const last = (): FakeSocket => { const socket = sockets.at(-1); assert.ok(socket); return socket; };
  return { connection, storage, clock, sockets, statuses, states, ops, rejects, last };
}
const PAIR = "PAIRCODE_abcdefghij", TOKEN = "DEVICETOKEN_abcdefghijkl", NEW_TOKEN = "NEWTOKEN_abcdefghijklmn";
function online(f: ReturnType<typeof setup>): FakeSocket {
  f.connection.connect(); const socket = f.last(); socket.open();
  socket.receive({ t: "welcome", deviceId: "d1", name: "Test iPad", device: NEW_TOKEN });
  return socket;
}

// ---------- CompanionConnection ----------
describe("CompanionConnection", () => {
  it("without credentials goes straight to denied and opens no socket", () => {
    const f = setup(); f.connection.connect();
    assert.equal(f.sockets.length, 0); assert.equal(f.connection.state, "denied");
    assert.equal(f.connection.hasCredentials(), false);
  });
  it("hello includes the pair code and then the stored device token", () => {
    const f = setup({ pairCode: PAIR }); f.connection.connect();
    assert.equal(f.connection.state, "connecting");
    f.last().open();
    assert.deepEqual(f.last().sent[0], { t: "hello", v: PROTOCOL_VERSION, pair: PAIR, name: "Test iPad" });

    const g = setup({ token: TOKEN }); g.connection.connect(); g.last().open();
    assert.deepEqual(g.last().sent[0], { t: "hello", v: PROTOCOL_VERSION, device: TOKEN, name: "Test iPad" });

    const h = setup({ token: TOKEN, pairCode: PAIR }); h.connection.connect(); h.last().open();
    assert.deepEqual(h.last().sent[0], { t: "hello", v: PROTOCOL_VERSION, device: TOKEN, pair: PAIR, name: "Test iPad" });
  });
  it("welcome stores the token, clears the pair code and goes online", () => {
    const f = setup({ pairCode: PAIR }); online(f);
    assert.equal(f.storage.getItem(TOKEN_KEY), NEW_TOKEN);
    assert.equal(f.connection.state, "online"); assert.equal(f.connection.online, true);
    assert.equal(f.statuses.at(-1)?.state, "online");
    // Abnormal close: the reconnect hello carries only the device token, no pair code.
    f.last().serverClose(1006);
    f.clock.advance(500);
    assert.equal(f.sockets.length, 2); f.last().open();
    assert.deepEqual(f.last().sent[0], { t: "hello", v: PROTOCOL_VERSION, device: NEW_TOKEN, name: "Test iPad" });
  });
  it("denied followed by close 4003 forgets the token and stops reconnecting", () => {
    const f = setup({ token: TOKEN }); f.connection.connect(); const socket = f.last(); socket.open();
    socket.receive({ t: "denied", reason: "Not paired." });
    assert.equal(f.connection.state, "denied"); assert.equal(f.statuses.at(-1)?.detail, "Not paired.");
    socket.serverClose(4003, "Not paired.");
    assert.equal(f.storage.getItem(TOKEN_KEY), null);
    assert.equal(f.connection.state, "denied");
    assert.equal(f.clock.timers.size, 0);
    f.clock.advance(60_000); f.connection.wake(); f.connection.connect();
    assert.equal(f.sockets.length, 1);
  });
  it("close 4001 (revoked) forgets the token and reports denied with the reason", () => {
    const f = setup(); f.storage.setItem(TOKEN_KEY, TOKEN); online(f);
    f.last().serverClose(4001, "Revoked on the desktop.");
    assert.equal(f.storage.getItem(TOKEN_KEY), null);
    assert.equal(f.connection.state, "denied");
    assert.deepEqual(f.statuses.at(-1), { state: "denied", detail: "Revoked on the desktop." });
    assert.equal(f.clock.timers.size, 0);
    assert.equal(f.connection.hasCredentials(), false);
  });
  it("abnormal closes reconnect with exponential backoff capped at 5s", () => {
    const f = setup({ token: TOKEN }); f.connection.connect();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      f.last().serverClose(1006);
      assert.equal(f.connection.state, "offline");
      const pending = f.clock.pending(); assert.equal(pending.length, 1);
      delays.push(pending[0]!);
      const before = f.sockets.length;
      f.clock.advance(pending[0]! - 1); assert.equal(f.sockets.length, before, "not before the delay");
      f.clock.advance(1); assert.equal(f.sockets.length, before + 1, "reconnects at the delay");
    }
    assert.deepEqual(delays, [500, 1000, 2000, 4000, 5000, 5000, 5000]);
  });
  it("a successful welcome resets the backoff", () => {
    const f = setup({ token: TOKEN }); f.connection.connect();
    f.last().serverClose(1006); f.clock.advance(500);
    f.last().serverClose(1006); f.clock.advance(1000);
    f.last().open(); f.last().receive({ t: "welcome", deviceId: "d", name: "n" });
    f.last().serverClose(1006);
    const retry = [...f.clock.timers.values()].filter(timer => timer.ms !== 10_000).map(timer => timer.ms);
    assert.deepEqual(retry, [500]);
  });
  it("wake() reconnects immediately instead of waiting for the backoff", () => {
    const f = setup({ token: TOKEN }); f.connection.connect();
    for (let i = 0; i < 3; i++) { f.last().serverClose(1006); f.clock.advance(10_000); }
    f.last().serverClose(1006);
    assert.deepEqual(f.clock.pending(), [4000]);
    const before = f.sockets.length;
    f.connection.wake();
    assert.equal(f.sockets.length, before + 1);
    assert.equal(f.connection.state, "connecting");
    assert.equal(f.clock.timers.size, 0, "pending retry timer is cancelled");
    // Backoff restarted from the first step.
    f.last().serverClose(1006);
    assert.deepEqual(f.clock.pending(), [500]);
  });
  it("wake() keeps a live socket but replaces a dead one", () => {
    const f = setup({ token: TOKEN }); online(f);
    f.connection.wake(); assert.equal(f.sockets.length, 1);
    f.clock.time += 26_000; // no timers fire; simulate a suspended page
    f.connection.wake();
    assert.equal(f.sockets.length, 2);
    assert.ok(f.sockets[0]!.closed, "dead socket closed");
  });
  it("sends heartbeat pings every 10s while hearing from the server", () => {
    const f = setup({ token: TOKEN }); const socket = online(f);
    const pings = () => socket.sent.filter(message => (message as { t: string }).t === "ping").length;
    f.clock.advance(10_000); assert.equal(pings(), 1);
    socket.receive({ t: "pong" });
    f.clock.advance(10_000); assert.equal(pings(), 2);
    socket.receive({ t: "pong" });
    f.clock.advance(10_000); assert.equal(pings(), 3);
    assert.equal(f.connection.state, "online");
  });
  it("detects a dead connection after 25s of silence and reconnects", () => {
    const f = setup({ token: TOKEN }); const socket = online(f);
    f.clock.advance(20_000);
    assert.equal(f.connection.state, "online"); assert.equal(socket.closed, undefined);
    f.clock.advance(10_000); // t=30s, last heard at 0
    assert.ok(socket.closed); assert.equal(f.connection.state, "offline");
    assert.equal(f.sockets.length, 1);
    f.clock.advance(500); assert.equal(f.sockets.length, 2);
    // A late close event from the dropped socket is ignored.
    socket.onclose?.({ code: 1006, reason: "" });
  });
  it("invalid state or op triggers {t:\"sync\"}; valid ones reach the handlers", () => {
    const f = setup({ token: TOKEN }); const socket = online(f);
    socket.receive({ t: "state", doc: { id: "bad" }, host: true });
    socket.receive({ t: "op", doc: "doc-a", rev: 0, op: { k: "pop" }, redo: 0 });
    socket.receive({ t: "op", doc: "doc-a", rev: 1, op: { k: "nope" }, redo: 0 });
    assert.deepEqual(socket.sent.filter(message => (message as { t: string }).t === "sync"), [{ t: "sync" }, { t: "sync" }, { t: "sync" }]);
    assert.equal(f.states.length, 0); assert.equal(f.ops.length, 0);

    socket.receive({ t: "state", doc: snapshot("doc-a", [wire("s1")]), host: true });
    socket.receive({ t: "state", doc: null, host: false });
    socket.receive(op("doc-a", 2, { k: "pop" }, 1));
    socket.receive({ t: "reject", id: "s9", reason: "Too big." });
    assert.equal(f.states.length, 2);
    assert.deepEqual(f.states[0], { doc: snapshot("doc-a", [wire("s1")]), host: true });
    assert.deepEqual(f.states[1], { doc: null, host: false });
    assert.deepEqual(f.ops, [op("doc-a", 2, { k: "pop" }, 1)]);
    assert.deepEqual(f.rejects, [["s9", "Too big."]]);
  });
  it("send() returns false while offline or unauthenticated, true when online", () => {
    const f = setup({ token: TOKEN });
    assert.equal(f.connection.send({ t: "sync" }), false);
    f.connection.connect(); f.last().open();
    assert.equal(f.connection.send({ t: "sync" }), false, "open but not welcomed");
    f.last().receive({ t: "welcome", deviceId: "d", name: "n" });
    assert.equal(f.connection.send({ t: "undo", doc: "doc-a" }), true);
    assert.deepEqual(f.last().sent.at(-1), { t: "undo", doc: "doc-a" });
    f.last().serverClose(1006);
    assert.equal(f.connection.send({ t: "undo", doc: "doc-a" }), false);
  });
  it("stop() closes the socket and never reconnects", () => {
    const f = setup({ token: TOKEN }); const socket = online(f);
    f.connection.stop();
    assert.ok(socket.closed); assert.equal(f.clock.timers.size, 0);
    f.clock.advance(60_000); f.connection.wake();
    assert.equal(f.sockets.length, 1);
  });
  it("pair() replaces credentials with a fresh pairing code after denial", () => {
    const f = setup({ token: TOKEN }); f.connection.connect(); f.last().open();
    f.last().serverClose(4003, "Not paired.");
    assert.equal(f.connection.state, "denied");
    f.connection.pair(PAIR);
    assert.equal(f.sockets.length, 2); f.last().open();
    assert.deepEqual(f.last().sent[0], { t: "hello", v: PROTOCOL_VERSION, pair: PAIR, name: "Test iPad" });
  });
});

// ---------- CompanionDocument ----------
describe("CompanionDocument", () => {
  it("starts empty and unknown", () => {
    const doc = new CompanionDocument();
    assert.equal(doc.id, undefined); assert.equal(doc.rev, 0); assert.equal(doc.redo, 0);
    assert.equal(doc.canUndo, false); assert.equal(doc.known, false);
    assert.deepEqual(doc.displayStrokes(), []);
    assert.equal(doc.addPending(wire("p")), undefined, "no sheet: nothing to draw on");
  });
  it("applyState sets committed strokes, metadata and getters", () => {
    const doc = new CompanionDocument();
    const result = doc.applyState(snapshot("doc-a", [wire("s1", 1), { ...wire("s2", 2), size: 4 }], 5, 2), true);
    assert.deepEqual(result, { docChanged: true, resend: [] });
    assert.equal(doc.id, "doc-a"); assert.equal(doc.rev, 5); assert.equal(doc.redo, 2);
    assert.equal(doc.host, true); assert.equal(doc.known, true); assert.equal(doc.canUndo, true);
    assert.deepEqual(doc.committedStrokes(), [
      { tool: "pen", points: [{ x: 1, y: 2, pressure: 0.5 }], id: "s1" },
      { tool: "pen", points: [{ x: 2, y: 2, pressure: 0.5 }], id: "s2", size: 4 },
    ]);
    assert.equal(doc.applyState(snapshot("doc-a", [], 6), true).docChanged, false);
    assert.equal(doc.canUndo, false);
  });
  it("applyState keeps pending strokes not yet committed and returns them for resend", () => {
    const doc = new CompanionDocument();
    doc.applyState(snapshot("doc-a"), true);
    doc.addPending(wire("p1", 1)); doc.addPending(wire("p2", 2)); doc.addPending(wire("p3", 3));
    const result = doc.applyState(snapshot("doc-a", [wire("p1", 1)]), true);
    assert.equal(result.docChanged, false);
    assert.deepEqual(result.resend, [wire("p2", 2), wire("p3", 3)]);
    assert.deepEqual(doc.pending.map(pending => pending.wire.id), ["p2", "p3"]);
    assert.equal(doc.dropped, 0);
  });
  it("applyState drops pending strokes from another sheet and counts them", () => {
    const doc = new CompanionDocument();
    doc.applyState(snapshot("doc-a"), true);
    doc.addPending(wire("p1")); doc.addPending(wire("p2"));
    const result = doc.applyState(snapshot("doc-b"), true);
    assert.deepEqual(result, { docChanged: true, resend: [] });
    assert.equal(doc.pending.length, 0); assert.equal(doc.dropped, 2);
    assert.equal(doc.takeDropped(), 2); assert.equal(doc.takeDropped(), 0);
    doc.addPending(wire("p3"));
    doc.applyState(null, false);
    assert.equal(doc.takeDropped(), 1); assert.equal(doc.id, undefined); assert.equal(doc.host, false);
  });
  it("push op commits and resolves the matching pending stroke", () => {
    const doc = new CompanionDocument();
    doc.applyState(snapshot("doc-a", [wire("s1")], 1), true);
    doc.addPending(wire("p1", 5)); doc.addPending(wire("p2", 6));
    assert.equal(doc.applyOp(op("doc-a", 2, { k: "push", stroke: wire("p1", 5) })), "ok");
    assert.equal(doc.rev, 2);
    assert.deepEqual(doc.pending.map(pending => pending.wire.id), ["p2"]);
    assert.deepEqual(doc.committedStrokes().map(stroke => stroke.id), ["s1", "p1"]);
    assert.deepEqual(doc.doc?.strokes.map(stroke => stroke.id), ["s1", "p1"]);
  });
  it("displayStrokes shows committed ink then pending strokes in drawing order", () => {
    const doc = new CompanionDocument();
    doc.applyState(snapshot("doc-a", [wire("s1", 1)], 1), true);
    doc.addPending(wire("p1", 2)); doc.addPending(wire("p2", 3));
    doc.applyOp(op("doc-a", 2, { k: "push", stroke: wire("s2", 4) }));
    assert.deepEqual(doc.displayStrokes().map(stroke => stroke.id), ["s1", "s2", "p1", "p2"]);
  });
  it("rev gaps and foreign sheets ask for resync; duplicates are ignored", () => {
    const doc = new CompanionDocument();
    assert.equal(doc.applyOp(op("doc-a", 1, { k: "pop" })), "resync", "no sheet yet");
    doc.applyState(snapshot("doc-a", [wire("s1"), wire("s2")], 4), true);
    assert.equal(doc.applyOp(op("doc-a", 6, { k: "pop" })), "resync");
    assert.equal(doc.applyOp(op("doc-b", 5, { k: "pop" })), "resync");
    assert.equal(doc.applyOp(op("doc-a", 4, { k: "pop" })), "ignored");
    assert.equal(doc.applyOp(op("doc-a", 3, { k: "pop" })), "ignored");
    assert.equal(doc.rev, 4); assert.equal(doc.committedStrokes().length, 2);
  });
  it("pop updates strokes, redo depth and canUndo", () => {
    const doc = new CompanionDocument();
    doc.applyState(snapshot("doc-a", [wire("s1")], 1), true);
    assert.equal(doc.canUndo, true);
    assert.equal(doc.applyOp(op("doc-a", 2, { k: "pop" }, 1)), "ok");
    assert.equal(doc.canUndo, false); assert.equal(doc.redo, 1); assert.equal(doc.rev, 2);
    assert.deepEqual(doc.displayStrokes(), []);
  });
  it("reset op replaces committed strokes and resolves pending ones it contains", () => {
    const doc = new CompanionDocument();
    doc.applyState(snapshot("doc-a", [wire("s1"), wire("s2")], 2, 3), true);
    doc.addPending(wire("p1")); doc.addPending(wire("p2"));
    assert.equal(doc.applyOp(op("doc-a", 3, { k: "reset", strokes: [wire("s1"), wire("p2")] }, 0)), "ok");
    assert.deepEqual(doc.committedStrokes().map(stroke => stroke.id), ["s1", "p2"]);
    assert.deepEqual(doc.pending.map(pending => pending.wire.id), ["p1"]);
    assert.equal(doc.redo, 0);
    assert.equal(doc.applyOp(op("doc-a", 4, { k: "reset", strokes: [] })), "ok");
    assert.equal(doc.canUndo, false);
    assert.deepEqual(doc.displayStrokes().map(stroke => stroke.id), ["p1"]);
  });
  it("reject(id) removes only that pending stroke", () => {
    const doc = new CompanionDocument();
    doc.applyState(snapshot("doc-a"), true);
    doc.addPending(wire("p1")); doc.addPending(wire("p2"));
    assert.equal(doc.reject("p1"), true);
    assert.equal(doc.reject("p1"), false);
    assert.equal(doc.reject("zzz"), false);
    assert.deepEqual(doc.displayStrokes().map(stroke => stroke.id), ["p2"]);
  });
});
