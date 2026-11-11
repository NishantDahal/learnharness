import assert from "node:assert/strict";
import { describe, it } from "node:test";
import http from "node:http";
import { WebSocket } from "ws";
import { allowedHost, allowedOrigin, CompanionServer, MAX_CLIENTS, MAX_PENDING_PER_ADDRESS, type CompanionEvents } from "../src/companion/server.ts";
import { AttemptLimiter, Pairing, type DeviceRecord, type DeviceSummary, type PairingStore } from "../src/companion/pairing.ts";
import type { DocSnapshot, Intent, LiveMessage, OpMessage, ServerMessage, WireStroke } from "../src/companion/protocol.ts";

const ASSETS = { html: "<!doctype html><title>pad</title>", js: "console.log('pad');", css: "body{margin:0}" };
const WAIT_MS = 3_000;

interface Saved { devices: DeviceRecord[] }
function memoryStore(): PairingStore & { saves: Saved[] } {
  const saves: Saved[] = [];
  return { saves, load: () => undefined, save(devices) { saves.push({ devices: structuredClone(devices) }); } };
}

interface Recorded {
  intents: { intent: Intent; device: DeviceSummary }[];
  live: { message: LiveMessage; device: DeviceSummary }[];
  changed: number;
  needState: number;
}

async function fixture(options: { clock?: { now: number } } = {}) {
  const clock = options.clock;
  const now = clock ? () => clock.now : Date.now;
  const store = memoryStore();
  const pairing = new Pairing(store, now);
  const recorded: Recorded = { intents: [], live: [], changed: 0, needState: 0 };
  const events: CompanionEvents = {
    intent(intent, device) { recorded.intents.push({ intent, device }); },
    live(message, device) { recorded.live.push({ message, device }); },
    changed() { recorded.changed++; },
    needState() { recorded.needState++; },
  };
  const server = new CompanionServer(ASSETS, pairing, events, now);
  const port = await server.start(0, "127.0.0.1");
  const peers: Peer[] = [];
  return {
    server, pairing, store, recorded, port,
    origin: `http://127.0.0.1:${port}`,
    async connect(opts: { origin?: string | null; path?: string; headers?: Record<string, string> } = {}): Promise<Peer> {
      const peer = await Peer.open(port, opts);
      peers.push(peer);
      return peer;
    },
    async pair(name = "Test iPad"): Promise<{ peer: Peer; token: string; deviceId: string }> {
      const { code } = pairing.createCode();
      const peer = await this.connect();
      peer.send({ t: "hello", v: 1, pair: code, name });
      const welcome = await peer.next();
      assert.equal(welcome.t, "welcome");
      assert.ok(welcome.t === "welcome" && welcome.device);
      return { peer, token: welcome.device!, deviceId: welcome.deviceId };
    },
    async close() {
      for (const peer of peers) peer.socket.terminate();
      await server.stop();
    },
  };
}

/** A thin ws client that queues server frames and records the close event. */
class Peer {
  private readonly queue: ServerMessage[] = [];
  private waiter: ((message: ServerMessage) => void) | undefined;
  readonly closed: Promise<{ code: number; reason: string }>;
  private constructor(readonly socket: WebSocket) {
    socket.on("message", data => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      const waiter = this.waiter;
      if (waiter) { this.waiter = undefined; waiter(message); } else this.queue.push(message);
    });
    this.closed = new Promise(resolve => socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  }
  static open(port: number, opts: { origin?: string | null; path?: string; headers?: Record<string, string> }): Promise<Peer> {
    const origin = opts.origin === undefined ? `http://127.0.0.1:${port}` : opts.origin;
    const socket = new WebSocket(`ws://127.0.0.1:${port}${opts.path ?? "/ws"}`, {
      ...(origin !== null ? { origin } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    socket.on("error", () => { /* surfaced through close / unexpected-response */ });
    return new Promise((resolve, reject) => {
      socket.once("open", () => resolve(new Peer(socket)));
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        reject(Object.assign(new Error(`HTTP ${response.statusCode}`), { status: response.statusCode }));
      });
      socket.once("close", () => reject(new Error("closed before open")));
    });
  }
  send(value: unknown): void { this.socket.send(JSON.stringify(value)); }
  next(timeout = WAIT_MS): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = undefined; reject(new Error("timed out waiting for a message")); }, timeout);
      this.waiter = message => { clearTimeout(timer); resolve(message); };
    });
  }
  /** Resolves true if no frame arrives within `ms`. */
  async quiet(ms = 100): Promise<boolean> {
    if (this.queue.length) return false;
    try { await this.next(ms); return false; } catch { return true; }
  }
  async closeCode(timeout = WAIT_MS): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeout); });
    try { return (await Promise.race([this.closed, limit])).code; } finally { clearTimeout(timer); }
  }
}

async function refusedStatus(promise: Promise<Peer>): Promise<number | undefined> {
  try { const peer = await promise; peer.socket.terminate(); return undefined; }
  catch (error) { return (error as { status?: number }).status; }
}

function request(port: number, path: string, options: { method?: string; host?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", agent: false,
      headers: options.host !== undefined ? { host: options.host } : {} }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const stroke = (id: string): WireStroke => ({ id, tool: "pen", size: 1, pts: [1, 2, 0.5, 3, 4, 0.5] });
function snapshot(over: Partial<DocSnapshot> = {}): DocSnapshot {
  return { id: "win1:sess:sheet", rev: 0, kind: "practice", label: "Blank sheet", width: 0, height: 0, background: "",
    backgroundColor: "#ffffff", mode: "light", strokes: [], redo: 0, ...over };
}

describe("allowedHost", () => {
  it("accepts IP literals, localhost and single-label mDNS names on the right port", () => {
    for (const host of ["127.0.0.1:8123", "192.168.1.20:8123", "[::1]:8123", "localhost:8123", "LOCALHOST:8123", "my-mac.local:8123", "Studio.LOCAL:8123"])
      assert.equal(allowedHost(host, 8123), true, host);
    assert.equal(allowedHost("10.0.0.2", 80), true);
    assert.equal(allowedHost("10.0.0.2:80", 80), true);
  });
  it("rejects missing, foreign, wrong-port and malformed hosts", () => {
    for (const host of [undefined, "", "evil.com:8123", "attacker.example:8123", "a.b.local:8123", "localhost.:8123", "127.0.0.1:8124",
      "127.0.0.1", "user@127.0.0.1:8123", "127.0.0.1:8123/x", "127.0.0.1:8123?q", "127.0.0.1:8123#h", "127.0.0.1:abc", "x".repeat(256),
      "-bad host:8123"])
      assert.equal(allowedHost(host, 8123), false, String(host));
  });
});

describe("allowedOrigin", () => {
  it("accepts only an http origin equal to the Host header", () => {
    assert.equal(allowedOrigin("http://127.0.0.1:8123", "127.0.0.1:8123"), true);
    assert.equal(allowedOrigin("http://my-mac.local:8123", "MY-MAC.local:8123"), true);
    assert.equal(allowedOrigin("http://10.0.0.2", "10.0.0.2"), true);
  });
  it("rejects missing, foreign, https, null and non-canonical origins", () => {
    const host = "127.0.0.1:8123";
    for (const origin of [undefined, "", "null", "https://127.0.0.1:8123", "http://127.0.0.1:8124", "http://evil.com",
      "http://127.0.0.1:8123/", "http://127.0.0.1:8123/path", "file://", "http://user@127.0.0.1:8123"])
      assert.equal(allowedOrigin(origin, host), false, String(origin));
    assert.equal(allowedOrigin("http://127.0.0.1:8123", undefined), false);
  });
});

describe("AttemptLimiter", () => {
  it("blocks an address after repeated failures inside the window and recovers after it", () => {
    const clock = { now: 1_000 };
    const limiter = new AttemptLimiter(3, 10_000, () => clock.now);
    for (let i = 0; i < 2; i++) limiter.fail("a");
    assert.equal(limiter.blocked("a"), false);
    limiter.fail("a");
    assert.equal(limiter.blocked("a"), true);
    assert.equal(limiter.blocked("b"), false);
    clock.now += 10_001;
    assert.equal(limiter.blocked("a"), false);
  });
});

describe("Pairing", () => {
  it("persists only token hashes, never the raw device token or pairing code", () => {
    const store = memoryStore();
    const pairing = new Pairing(store);
    const { code } = pairing.createCode();
    const redeemed = pairing.redeem(code, "Pad");
    assert.ok(redeemed);
    assert.equal(store.saves.length, 1);
    const text = JSON.stringify(store.saves[0]);
    assert.ok(!text.includes(redeemed.token), "raw token persisted");
    assert.ok(!text.includes(code), "pairing code persisted");
    const record = store.saves[0]!.devices[0]!;
    assert.match(record.hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(record).sort(), ["created", "hash", "id", "lastSeen", "name"]);
    // A store reloaded from the saved data authenticates the token but not the hash itself.
    const reloaded = new Pairing({ load: () => ({ version: 1, devices: store.saves[0]!.devices }), save() {} });
    assert.equal(reloaded.authenticate(redeemed.token)?.id, redeemed.device.id);
    assert.equal(reloaded.authenticate(record.hash), undefined);
  });
  it("codes are single use and expire", () => {
    const clock = { now: 0 };
    const pairing = new Pairing(memoryStore(), () => clock.now);
    const first = pairing.createCode(1_000);
    assert.ok(pairing.redeem(first.code, "A"));
    assert.equal(pairing.redeem(first.code, "A"), undefined);
    const second = pairing.createCode(1_000);
    clock.now = 1_000;
    assert.equal(pairing.redeem(second.code, "B"), undefined);
    assert.equal(pairing.codeExpires(), undefined);
  });
});

describe("CompanionServer HTTP", () => {
  it("serves the page with CSP and no-store, and its assets", async () => {
    const f = await fixture();
    try {
      const page = await request(f.port, "/");
      assert.equal(page.status, 200);
      assert.equal(page.body, ASSETS.html);
      assert.match(String(page.headers["content-type"]), /^text\/html/);
      assert.equal(page.headers["cache-control"], "no-store");
      const csp = String(page.headers["content-security-policy"]);
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(page.headers["x-frame-options"], "DENY");
      assert.equal(page.headers["x-content-type-options"], "nosniff");
      const query = await request(f.port, "/?pair=abc");
      assert.equal(query.status, 200);

      const js = await request(f.port, "/app.js");
      assert.equal(js.status, 200);
      assert.equal(js.body, ASSETS.js);
      assert.match(String(js.headers["content-type"]), /^text\/javascript/);
      assert.equal(js.headers["cache-control"], "no-store");
      const css = await request(f.port, "/app.css");
      assert.equal(css.status, 200);
      assert.equal(css.body, ASSETS.css);
      assert.match(String(css.headers["content-type"]), /^text\/css/);

      const head = await request(f.port, "/", { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.body, "");
    } finally { await f.close(); }
  });
  it("404s other paths, 405s other methods and 421s foreign hosts", async () => {
    const f = await fixture();
    try {
      for (const path of ["/index.html", "/app.js.map", "/../package.json", "/ws", "/api/settings", "//app.js"]) {
        const response = await request(f.port, path);
        assert.equal(response.status, 404, path);
        assert.equal(response.headers["cache-control"], "no-store");
      }
      const post = await request(f.port, "/", { method: "POST" });
      assert.equal(post.status, 405);
      assert.equal(post.headers.allow, "GET, HEAD");
      assert.equal((await request(f.port, "/", { method: "PUT" })).status, 405);
      const foreign = await request(f.port, "/", { host: `evil.example:${f.port}` });
      assert.equal(foreign.status, 421);
      assert.notEqual(foreign.body, ASSETS.html);
      assert.equal((await request(f.port, "/app.js", { host: "127.0.0.1:1" })).status, 421);
    } finally { await f.close(); }
  });
});

describe("CompanionServer WebSocket upgrade", () => {
  it("refuses missing or foreign Origin, foreign Host and wrong paths", async () => {
    const f = await fixture();
    try {
      assert.equal(await refusedStatus(f.connect({ origin: null })), 403);
      assert.equal(await refusedStatus(f.connect({ origin: "http://evil.example" })), 403);
      assert.equal(await refusedStatus(f.connect({ origin: `https://127.0.0.1:${f.port}` })), 403);
      assert.equal(await refusedStatus(f.connect({ origin: `http://evil.example:${f.port}`, headers: { host: `evil.example:${f.port}` } })), 403);
      assert.equal(await refusedStatus(f.connect({ path: "/socket" })), 404);
      assert.equal(await refusedStatus(f.connect({ path: "/" })), 404);
      assert.equal(f.server.connected().length, 0);
    } finally { await f.close(); }
  });
  it("limits pending unauthenticated sockets per address", async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < MAX_PENDING_PER_ADDRESS; i++) await f.connect();
      assert.equal(await refusedStatus(f.connect()), 503);
    } finally { await f.close(); }
  });
});

describe("CompanionServer authentication", () => {
  it("redeems a valid pairing code once and issues a device token", async () => {
    const f = await fixture();
    try {
      const { peer, token, deviceId } = await f.pair("Kitchen iPad");
      assert.match(token, /^[A-Za-z0-9_-]{16,128}$/);
      assert.deepEqual(f.server.connected(), [{ id: deviceId, name: "Kitchen iPad" }]);
      assert.ok(f.recorded.changed >= 1);
      assert.ok(f.pairing.has(deviceId));
      peer.socket.terminate();

      // The same code cannot be redeemed twice.
      const { code } = f.pairing.createCode();
      const first = await f.connect();
      first.send({ t: "hello", v: 1, pair: code });
      assert.equal((await first.next()).t, "welcome");
      const again = await f.connect();
      again.send({ t: "hello", v: 1, pair: code });
      const denied = await again.next();
      assert.equal(denied.t, "denied");
      assert.equal(await again.closeCode(), 4003);
    } finally { await f.close(); }
  });
  it("denies an expired code with close 4003", async () => {
    const clock = { now: 1_000_000 };
    const f = await fixture({ clock });
    try {
      const { code } = f.pairing.createCode(60_000);
      clock.now += 60_000;
      const peer = await f.connect();
      peer.send({ t: "hello", v: 1, pair: code });
      const message = await peer.next();
      assert.equal(message.t, "denied");
      assert.match(message.t === "denied" ? message.reason : "", /expired/);
      assert.equal(await peer.closeCode(), 4003);
      assert.equal(f.pairing.list().length, 0);
    } finally { await f.close(); }
  });
  it("reconnects with the device token alone", async () => {
    const f = await fixture();
    try {
      const { peer, token, deviceId } = await f.pair();
      peer.socket.close();
      await peer.closed;
      const back = await f.connect();
      back.send({ t: "hello", v: 1, device: token, name: "ignored" });
      const welcome = await back.next();
      assert.equal(welcome.t, "welcome");
      assert.ok(welcome.t === "welcome");
      assert.equal(welcome.deviceId, deviceId);
      assert.equal(welcome.device, undefined, "token must not be re-issued");
      back.send({ t: "ping" });
      assert.equal((await back.next()).t, "pong");
    } finally { await f.close(); }
  });
  it("disconnects a revoked device with 4001 and refuses it afterwards", async () => {
    const f = await fixture();
    try {
      const { peer, token, deviceId } = await f.pair();
      const removed = f.pairing.revoke(deviceId);
      assert.deepEqual(removed, [deviceId]);
      f.server.disconnect(removed);
      assert.equal(await peer.closeCode(), 4001);
      const back = await f.connect();
      back.send({ t: "hello", v: 1, device: token });
      assert.equal((await back.next()).t, "denied");
      assert.equal(await back.closeCode(), 4003);
    } finally { await f.close(); }
  });
  it("closes a connected device with 4001 on its next message once revoked, without forwarding it", async () => {
    const f = await fixture();
    try {
      const { peer, deviceId } = await f.pair();
      f.pairing.revoke(deviceId);
      peer.send({ t: "undo", doc: "d1" });
      assert.equal(await peer.closeCode(), 4001);
      assert.equal(f.recorded.intents.length, 0);
    } finally { await f.close(); }
  });
  it("closes unauthenticated non-hello messages with 1008", async () => {
    const f = await fixture();
    try {
      const peer = await f.connect();
      peer.send({ t: "ping" });
      assert.equal(await peer.closeCode(), 1008);
      const stroker = await f.connect();
      stroker.send({ t: "stroke", doc: "d1", stroke: stroke("s1") });
      assert.equal(await stroker.closeCode(), 1008);
      assert.equal(f.recorded.intents.length, 0);
    } finally { await f.close(); }
  });
  it("rejects binary frames, invalid JSON, invalid shapes and oversized frames", async () => {
    const f = await fixture();
    try {
      const binary = (await f.pair()).peer;
      binary.socket.send(Buffer.from(JSON.stringify({ t: "ping" })), { binary: true });
      assert.equal(await binary.closeCode(), 1008);

      const invalid = (await f.pair()).peer;
      invalid.socket.send("{not json");
      assert.equal(await invalid.closeCode(), 1008);

      const extra = (await f.pair()).peer;
      extra.send({ t: "undo", doc: "d1", extra: true });
      assert.equal(await extra.closeCode(), 1008);

      const unauthBinary = await f.connect();
      unauthBinary.socket.send(Buffer.from("{}"), { binary: true });
      assert.equal(await unauthBinary.closeCode(), 1008);

      const big = (await f.pair()).peer;
      big.socket.send(JSON.stringify({ t: "sync", pad: "x".repeat(600 * 1024) }));
      const code = await big.closeCode();
      // ws enforces maxPayload itself before the parser sees the frame; the server then terminates (1006).
      assert.ok([1008, 1009, 1006].includes(code), `unexpected close ${code}`);
      assert.equal(f.recorded.intents.length, 0);
    } finally { await f.close(); }
  });
  it("rejects a second hello after authentication", async () => {
    const f = await fixture();
    try {
      const { peer, token } = await f.pair();
      peer.send({ t: "hello", v: 1, device: token });
      assert.equal(await peer.closeCode(), 1008);
    } finally { await f.close(); }
  });
  it("enforces the maximum number of authenticated devices", async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < MAX_CLIENTS; i++) await f.pair(`Pad ${i}`);
      assert.equal(f.server.connected().length, MAX_CLIENTS);
      const { code } = f.pairing.createCode();
      const extra = await f.connect();
      extra.send({ t: "hello", v: 1, pair: code });
      const denied = await extra.next();
      assert.equal(denied.t, "denied");
      assert.equal(await extra.closeCode(), 4004);
      assert.equal(f.server.connected().length, MAX_CLIENTS);
    } finally { await f.close(); }
  });
  it("blocks an address at upgrade after repeated failed hellos", async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 10; i++) {
        const peer = await f.connect();
        peer.send({ t: "hello", v: 1, device: "A".repeat(43) });
        assert.equal((await peer.next()).t, "denied");
        assert.equal(await peer.closeCode(), 4003);
      }
      assert.equal(await refusedStatus(f.connect()), 429);
    } finally { await f.close(); }
  });
});

describe("CompanionServer relay", () => {
  it("asks for state when unknown and sends current state after authentication when known", async () => {
    const f = await fixture();
    try {
      const { peer } = await f.pair();
      assert.equal(f.recorded.needState, 1);
      assert.equal(await peer.quiet(), true);
      peer.send({ t: "sync" });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(f.recorded.needState, 2);

      const doc = snapshot({ strokes: [stroke("a")], rev: 3 });
      f.server.setState(doc);
      const state = await peer.next();
      assert.deepEqual(state, { t: "state", doc, host: true });

      const second = await f.pair();
      assert.deepEqual(await second.peer.next(), { t: "state", doc, host: true });
      assert.equal(f.recorded.needState, 2);

      f.server.setState(null, false);
      assert.deepEqual(await peer.next(), { t: "state", doc: null, host: false });
      assert.deepEqual(await second.peer.next(), { t: "state", doc: null, host: false });
      const third = await f.pair();
      assert.deepEqual(await third.peer.next(), { t: "state", doc: null, host: false });
    } finally { await f.close(); }
  });
  it("does not broadcast state to unauthenticated sockets", async () => {
    const f = await fixture();
    try {
      const pending = await f.connect();
      f.server.setState(snapshot());
      assert.equal(await pending.quiet(), true);
    } finally { await f.close(); }
  });
  it("forwards intents and live messages with the device", async () => {
    const f = await fixture();
    try {
      const { peer, deviceId } = await f.pair("Pencil Pad");
      const doc = "win1:sess:sheet";
      peer.send({ t: "stroke", doc, stroke: stroke("s1") });
      peer.send({ t: "undo", doc });
      peer.send({ t: "redo", doc });
      peer.send({ t: "clear", doc });
      peer.send({ t: "live", doc, sid: "live1", tool: "pen", size: 2, from: 0, pts: [1, 1, 0.2] });
      peer.send({ t: "live-end", doc, sid: "live1" });
      peer.send({ t: "ping" });
      assert.equal((await peer.next()).t, "pong");
      assert.deepEqual(f.recorded.intents.map(entry => entry.intent), [
        { t: "stroke", doc, stroke: stroke("s1") }, { t: "undo", doc }, { t: "redo", doc }, { t: "clear", doc },
      ]);
      assert.deepEqual(f.recorded.live.map(entry => entry.message), [
        { t: "live", doc, sid: "live1", tool: "pen", size: 2, from: 0, pts: [1, 1, 0.2] }, { t: "live-end", doc, sid: "live1" },
      ]);
      for (const entry of [...f.recorded.intents, ...f.recorded.live]) {
        assert.equal(entry.device.id, deviceId);
        assert.equal(entry.device.name, "Pencil Pad");
      }
    } finally { await f.close(); }
  });
  it("applies ops with the next revision, broadcasts them, and refuses gaps", async () => {
    const f = await fixture();
    try {
      const { peer } = await f.pair();
      const other = await f.pair();
      const doc = snapshot({ rev: 2 });
      f.server.setState(doc);
      await peer.next(); await other.peer.next();

      const op: OpMessage = { t: "op", doc: doc.id, rev: 3, op: { k: "push", stroke: stroke("p1") }, redo: 0 };
      assert.equal(f.server.applyOp(op), true);
      assert.deepEqual(await peer.next(), op);
      assert.deepEqual(await other.peer.next(), op);

      assert.equal(f.server.applyOp({ ...op, rev: 5 }), false, "gap");
      assert.equal(f.server.applyOp({ ...op, rev: 3 }), false, "replay");
      assert.equal(f.server.applyOp({ ...op, rev: 4, doc: "other-doc" }), false, "wrong doc");
      assert.equal(await peer.quiet(), true);

      const pop: OpMessage = { t: "op", doc: doc.id, rev: 4, op: { k: "pop" }, redo: 1 };
      assert.equal(f.server.applyOp(pop), true);
      assert.deepEqual(await peer.next(), pop);
      const push: OpMessage = { t: "op", doc: doc.id, rev: 5, op: { k: "push", stroke: stroke("p2") }, redo: 0 };
      assert.equal(f.server.applyOp(push), true);
      await peer.next();

      // A device joining now gets the mirrored state including applied ops.
      const late = await f.pair();
      assert.deepEqual(await late.peer.next(), { t: "state", doc: { ...doc, rev: 5, redo: 0, strokes: [stroke("p2")] }, host: true });
    } finally { await f.close(); }
  });
  it("returns false from applyOp when no state is known", async () => {
    const f = await fixture();
    try {
      assert.equal(f.server.applyOp({ t: "op", doc: "d", rev: 1, op: { k: "pop" }, redo: 0 }), false);
      f.server.setState(null);
      assert.equal(f.server.applyOp({ t: "op", doc: "d", rev: 1, op: { k: "pop" }, redo: 0 }), false);
    } finally { await f.close(); }
  });
  it("broadcasts rejections to authenticated devices", async () => {
    const f = await fixture();
    try {
      const { peer } = await f.pair();
      f.server.reject("s1", "Stale drawing.");
      assert.deepEqual(await peer.next(), { t: "reject", id: "s1", reason: "Stale drawing." });
    } finally { await f.close(); }
  });
  it("stop terminates clients and stops listening", async () => {
    const f = await fixture();
    const { peer } = await f.pair();
    await f.close();
    assert.equal(f.server.listening, false);
    assert.equal(f.server.address, 0);
    assert.notEqual(await peer.closeCode(), 1000);
    await assert.rejects(request(f.port, "/"));
  });
});

describe("CompanionServer hardening (review regressions)", () => {
  it("keeps one connection per device: a newer page replaces the older (4005)", async () => {
    const f = await fixture();
    try {
      const { peer: first, token } = await f.pair();
      const second = await f.connect();
      second.send({ t: "hello", v: 1, device: token });
      assert.equal((await second.next()).t, "welcome");
      assert.equal(await first.closeCode(), 4005);
      assert.equal(f.server.connected().length, 1);
    } finally { await f.close(); }
  });
  it("checks capacity before consuming a pairing code", async () => {
    const f = await fixture();
    try {
      const pads = [];
      for (let i = 0; i < MAX_CLIENTS; i++) pads.push(await f.pair(`Pad ${i}`));
      const devicesBefore = f.pairing.list().length;
      const { code } = f.pairing.createCode();
      const extra = await f.connect();
      extra.send({ t: "hello", v: 1, pair: code, name: "Extra" });
      assert.equal((await extra.next()).t, "denied");
      assert.equal(await extra.closeCode(), 4004);
      assert.equal(f.pairing.list().length, devicesBefore, "no orphan device record");
      pads[0]!.peer.socket.close();
      await pads[0]!.peer.closed;
      const retry = await f.connect();
      retry.send({ t: "hello", v: 1, pair: code, name: "Extra" });
      assert.equal((await retry.next()).t, "welcome", "the code was not burned by the refusal");
    } finally { await f.close(); }
  });
  it("rate-limits committed edits separately from live points", async () => {
    const f = await fixture();
    try {
      const { peer } = await f.pair();
      for (let i = 0; i < 40; i++) peer.send({ t: "undo", doc: "h.s.1" });
      assert.equal(await peer.closeCode(), 1008);
      assert.ok(f.recorded.intents.length <= 30);
    } finally { await f.close(); }
  });
  it("counts invalid pre-authentication frames as failed attempts", async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 10; i++) {
        const peer = await f.connect();
        peer.send({ t: "ping" });
        await peer.closeCode();
      }
      assert.equal(await refusedStatus(f.connect()), 429);
    } finally { await f.close(); }
  });
});

describe("CompanionServer page build", () => {
  it("serves a build id with cache-busted assets and sends it in welcome", async () => {
    const { assetBuild } = await import("../src/companion/server.ts");
    const f = await fixture();
    try {
      const build = assetBuild(ASSETS);
      const page = await request(f.port, "/");
      assert.ok(page.body.length > 0);
      const { peer } = await f.pair();
      assert.ok(peer);
      const { code } = f.pairing.createCode();
      const other = await f.connect();
      other.send({ t: "hello", v: 1, pair: code });
      const welcome = await other.next();
      assert.equal(welcome.t === "welcome" && welcome.build, build);
    } finally { await f.close(); }
  });
  it("pageHtml injects the build meta and versioned asset URLs", async () => {
    const { pageHtml } = await import("../src/companion/server.ts");
    const html = pageHtml({ html: '<head><link href="/app.css"><script src="/app.js"></script></head>', js: "", css: "" }, "abc");
    assert.match(html, /\/app\.js\?v=abc/); assert.match(html, /\/app\.css\?v=abc/);
    assert.match(html, /<meta name="lh-build" content="abc">/);
  });
});
