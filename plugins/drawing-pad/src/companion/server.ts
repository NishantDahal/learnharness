/** The LAN-facing companion server (backend only). It is deliberately tiny and
 * separate from LearnHarness's own loopback API server:
 *   GET /           the companion page        GET /app.js, /app.css   its assets
 *   GET /ws         WebSocket upgrade; the first frame must authenticate.
 * Everything else is 404. It never proxies, reads or exposes app data, chats,
 * settings, credentials or environment; it only relays validated drawing messages
 * between authenticated devices and the desktop window that owns the drawing. */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { AttemptLimiter, type DeviceSummary, type Pairing } from "./pairing.ts";
import { applyOp, LIMITS, parseClientMessage, PROTOCOL_VERSION, type DocSnapshot, type Intent, type LiveMessage,
  type OpMessage, type ServerMessage } from "./protocol.ts";

export interface CompanionAssets { html: string; js: string; css: string }
/** Content hash of the page code. Served pages carry it, and devices running an older
 * page (kept open across a LearnHarness update) are told to reload. */
export function assetBuild(assets: CompanionAssets): string {
  let hash = 2166136261;
  for (const text of [assets.html, assets.js, assets.css]) for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
/** Inject the build id and cache-busting asset URLs into the page. */
export function pageHtml(assets: CompanionAssets, build: string): string {
  return assets.html.replace("/app.js", `/app.js?v=${build}`).replace("/app.css", `/app.css?v=${build}`)
    .replace("</head>", `  <meta name="lh-build" content="${build}">
</head>`);
}
export interface CompanionEvents {
  intent(intent: Intent, device: DeviceSummary): void;
  live(message: LiveMessage, device: DeviceSummary): void;
  /** Connected/paired device set or other status visible to the desktop changed. */
  changed(): void;
  /** A client needs state the server does not have; ask the desktop to publish it. */
  needState(): void;
}
interface Client { socket: WebSocket; address: string; device?: DeviceSummary; alive: boolean; budget: number; edits: number; window: number }

export const MAX_CLIENTS = 4, MAX_PENDING = 8, MAX_PENDING_PER_ADDRESS = 2, HELLO_TIMEOUT_MS = 5_000, HEARTBEAT_MS = 15_000;
/** Close codes understood by the companion page. */
export const CLOSE_REVOKED = 4001, CLOSE_NOT_PAIRED = 4003, CLOSE_BUSY = 4004, CLOSE_REPLACED = 4005;
const MESSAGES_PER_SECOND = 400, EDITS_PER_SECOND = 30, MAX_BUFFERED = 8 * 1024 * 1024;
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; manifest-src 'none'";

/** Host header guard against DNS rebinding: IP literals, localhost and mDNS names only. */
export function allowedHost(host: string | undefined, port: number): boolean {
  if (!host || host.length > 255) return false;
  let url: URL;
  try { url = new URL(`http://${host}`); } catch { return false; }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
  if ((url.port || "80") !== String(port)) return false;
  const name = url.hostname.replace(/^\[|\]$/g, "");
  return isIP(name) !== 0 || name === "localhost" || /^[a-z0-9-]{1,63}\.local$/i.test(name);
}
/** WebSocket upgrades must come from the companion page itself (blocks cross-site
 * WebSocket hijacking from any other origin, including other LAN pages). */
export function allowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && url.host.toLowerCase() === host.toLowerCase() && origin === url.origin;
  } catch { return false; }
}

export class CompanionServer {
  private server: http.Server | undefined;
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: LIMITS.messageBytes, perMessageDeflate: false });
  private readonly clients = new Set<Client>();
  private readonly limiter: AttemptLimiter;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private port = 0;
  /** Mirror of the desktop-owned drawing, so (re)connecting devices get full state. */
  private doc: DocSnapshot | null = null;
  private known = false;
  private hostAttached = false;
  private readonly build: string;

  constructor(private readonly assets: CompanionAssets, private readonly pairing: Pairing, private readonly events: CompanionEvents,
    private readonly now: () => number = Date.now) {
    this.limiter = new AttemptLimiter(10, 60_000, now);
    this.build = assetBuild(assets);
  }
  get listening(): boolean { return !!this.server?.listening; }
  get address(): number { return this.port; }

  async start(port: number, host = "0.0.0.0"): Promise<number> {
    if (this.server) return this.port;
    const server = http.createServer((request, response) => this.request(request, response));
    server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => this.upgrade(request, socket, head));
    server.on("clientError", (_error, socket) => socket.destroy());
    server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.maxHeadersCount = 50;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port, host, exclusive: true }, () => { server.off("error", reject); resolve(); });
    });
    this.server = server;
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : port;
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
    return this.port;
  }
  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear();
    const server = this.server;
    this.server = undefined; this.port = 0;
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
    this.events.changed();
  }

  connected(): { id: string; name: string }[] {
    return [...this.clients].flatMap(client => client.device ? [{ id: client.device.id, name: client.device.name }] : []);
  }
  /** The desktop published a complete sheet (or that none is targeted). */
  setState(doc: DocSnapshot | null, hostAttached = true): void {
    this.doc = doc; this.known = true; this.hostAttached = hostAttached;
    this.broadcast({ t: "state", doc, host: hostAttached });
  }
  /** Applies one desktop-committed operation; false means the mirror diverged. */
  applyOp(message: OpMessage): boolean {
    const doc = this.doc;
    if (!doc || doc.id !== message.doc || message.rev !== doc.rev + 1) return false;
    this.doc = { ...doc, rev: message.rev, redo: message.redo, strokes: applyOp(doc.strokes, message.op) };
    this.broadcast(message);
    return true;
  }
  reject(id: string, reason: string): void { this.broadcast({ t: "reject", id, reason }); }
  /** Disconnects the given devices (after revocation) or everyone. */
  disconnect(deviceIds?: readonly string[]): void {
    for (const client of this.clients) if (!deviceIds || (client.device && deviceIds.includes(client.device.id)))
      this.close(client, CLOSE_REVOKED, "Device access was revoked on the computer.");
    this.events.changed();
  }

  private request(request: IncomingMessage, response: ServerResponse): void {
    const send = (status: number, body: string, type = "text/plain; charset=utf-8", extra: Record<string, string> = {}) => {
      response.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "content-length": Buffer.byteLength(body), ...extra });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (!allowedHost(request.headers.host, this.port)) return send(421, "Misdirected request");
    if (request.method !== "GET" && request.method !== "HEAD") return send(405, "Method not allowed", undefined, { allow: "GET, HEAD" });
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/") return send(200, pageHtml(this.assets, this.build), "text/html; charset=utf-8", { "content-security-policy": CSP });
    if (path === "/app.js") return send(200, this.assets.js, "text/javascript; charset=utf-8");
    if (path === "/app.css") return send(200, this.assets.css, "text/css; charset=utf-8");
    send(404, "Not found");
  }
  private upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const host = request.headers.host, address = request.socket.remoteAddress ?? "unknown";
    if ((request.url ?? "").split("?")[0] !== "/ws") return refuse(404, "Not Found");
    if (!allowedHost(host, this.port) || !allowedOrigin(request.headers.origin, host)) return refuse(403, "Forbidden");
    if (this.limiter.blocked(address)) return refuse(429, "Too Many Requests");
    // Unauthenticated sockets are capped overall and per address, so another machine
    // on the network cannot hold every slot and lock a paired iPad out.
    const pending = [...this.clients].filter(client => !client.device);
    if (pending.length >= MAX_PENDING || pending.filter(client => client.address === address).length >= MAX_PENDING_PER_ADDRESS)
      return refuse(503, "Service Unavailable");
    this.sockets.handleUpgrade(request, socket, head, ws => this.accept(ws, address));
  }
  private accept(socket: WebSocket, address: string): void {
    const client: Client = { socket, address, alive: true, budget: MESSAGES_PER_SECOND, edits: EDITS_PER_SECOND, window: this.now() };
    this.clients.add(client);
    const timer = setTimeout(() => {
      if (!client.device) { this.limiter.fail(address); this.close(client, 4000, "Authentication timed out."); }
    }, HELLO_TIMEOUT_MS);
    timer.unref?.();
    socket.on("pong", () => { client.alive = true; });
    socket.on("message", (data: RawData, binary: boolean) => {
      try { this.message(client, data, binary); }
      catch {
        if (!client.device) this.limiter.fail(address);
        this.close(client, 1008, "Invalid message.");
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const wasAuthenticated = !!client.device;
      this.clients.delete(client);
      if (wasAuthenticated) this.events.changed();
    });
    socket.on("error", () => socket.terminate());
  }
  private message(client: Client, data: RawData, binary: boolean): void {
    if (binary) throw new Error("Binary frames are not accepted.");
    const time = this.now();
    if (time - client.window >= 1000) { client.window = time; client.budget = MESSAGES_PER_SECOND; client.edits = EDITS_PER_SECOND; }
    if (--client.budget < 0) { this.close(client, 1008, "Too many messages."); return; }
    const message = parseClientMessage(data.toString());
    if (!client.device) {
      if (message.t !== "hello") throw new Error("Authenticate first.");
      const name = message.name ?? "iPad";
      let device = message.device ? this.pairing.authenticate(message.device) : undefined, issued: string | undefined;
      const others = (id?: string) => [...this.clients].filter(other => other !== client && other.device && other.device.id !== id).length;
      // Check capacity before consuming a pairing code (a refused device must not
      // burn the code or leave an unusable device record behind).
      if (others(device?.id) >= MAX_CLIENTS) {
        this.send(client, { t: "denied", reason: "Too many companion devices are connected. Disconnect one and try again." });
        client.socket.close(CLOSE_BUSY, "Too many devices");
        return;
      }
      if (!device && message.pair) {
        const redeemed = this.pairing.redeem(message.pair, name);
        if (redeemed) { device = redeemed.device; issued = redeemed.token; }
      }
      if (!device) {
        this.limiter.fail(client.address);
        this.send(client, { t: "denied", reason: message.pair
          ? "This pairing code is invalid or has expired. Show a new QR code on your computer."
          : "This device is not paired (or was revoked). Scan the QR code shown on your computer." });
        client.socket.close(CLOSE_NOT_PAIRED, "Not paired");
        return;
      }
      // One connection per device: a newer page (reload, second tab) replaces the older.
      for (const other of this.clients) if (other !== client && other.device?.id === device.id)
        this.close(other, CLOSE_REPLACED, "This drawing page was opened again in another tab or window.");
      client.device = device;
      this.send(client, { t: "welcome", deviceId: device.id, name: device.name, build: this.build, ...(issued ? { device: issued } : {}) });
      this.sendState(client);
      this.events.changed();
      return;
    }
    // Revocation may happen while connected; never act for a removed device.
    if (!this.pairing.has(client.device.id)) { this.close(client, CLOSE_REVOKED, "Device access was revoked on the computer."); return; }
    switch (message.t) {
      case "hello": throw new Error("Already authenticated.");
      case "ping": this.send(client, { t: "pong" }); return;
      case "sync": this.sendState(client); return;
      case "live": case "live-end": this.events.live(message, client.device); return;
      default:
        // Committed edits are far rarer than live points; cap them separately.
        if (--client.edits < 0) { this.close(client, 1008, "Too many edits."); return; }
        this.events.intent(message, client.device);
    }
  }
  /** The mirrored sheet the server currently shows to devices. */
  currentState(): DocSnapshot | null { return this.doc; }
  private sendState(client: Client): void {
    if (!this.known) { this.events.needState(); return; }
    this.send(client, { t: "state", doc: this.doc, host: this.hostAttached });
  }
  private send(client: Client, message: ServerMessage): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    // A stalled device is dropped; it resynchronizes from a snapshot on reconnect.
    if (client.socket.bufferedAmount > MAX_BUFFERED) { client.socket.terminate(); return; }
    client.socket.send(JSON.stringify(message));
  }
  private broadcast(message: ServerMessage): void {
    const text = JSON.stringify(message);
    for (const client of this.clients) {
      if (!client.device || client.socket.readyState !== WebSocket.OPEN) continue;
      if (client.socket.bufferedAmount > MAX_BUFFERED) { client.socket.terminate(); continue; }
      client.socket.send(text);
    }
  }
  private close(client: Client, code: number, reason: string): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.close(code, reason);
    else client.socket.terminate();
  }
  private beat(): void {
    for (const client of this.clients) {
      if (!client.alive) { client.socket.terminate(); continue; }
      client.alive = false;
      try { client.socket.ping(); } catch { client.socket.terminate(); }
    }
  }
}
export { PROTOCOL_VERSION };
