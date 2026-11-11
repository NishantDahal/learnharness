/** Companion-device connection: authentication, automatic reconnection with backoff,
 * heartbeat, and full-state resynchronization. DOM-free for testing. */
import { parseDocSnapshot, parseOpMessage, PROTOCOL_VERSION, type ClientMessage, type DocSnapshot, type OpMessage } from "../protocol.ts";

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export type ConnectionState = "connecting" | "online" | "offline" | "denied";
export interface ConnectionHandlers {
  state(doc: DocSnapshot | null, host: boolean): void;
  op(message: OpMessage): void;
  reject(id: string, reason: string): void;
  status(state: ConnectionState, detail?: string): void;
  /** The server's page build; the app reloads itself if it is running an older page. */
  welcome?(build: string | undefined): void;
}
export interface ConnectionOptions {
  url: string;
  storage: StorageLike;
  createSocket(url: string): SocketLike;
  pairCode?: string;
  name?: string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  now?: () => number;
}
export const TOKEN_KEY = "learnharness-drawing-companion-device";
const OPEN = 1, PING_MS = 10_000, DEAD_MS = 25_000, MAX_BACKOFF_MS = 5_000;

export class CompanionConnection {
  state: ConnectionState = "connecting";
  private socket: SocketLike | undefined;
  private pairCode: string | undefined;
  private attempts = 0;
  private retryTimer: unknown;
  private pinger: unknown;
  private lastHeard = 0;
  private authenticated = false;
  private stopped = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly options: ConnectionOptions, private readonly handlers: ConnectionHandlers) {
    this.pairCode = options.pairCode;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? (id => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.now = options.now ?? Date.now;
  }
  get online(): boolean { return this.state === "online"; }
  hasCredentials(): boolean { return !!this.pairCode || !!this.token(); }
  private token(): string | undefined {
    try { return this.options.storage.getItem(TOKEN_KEY) ?? undefined; } catch { return undefined; }
  }
  connect(): void {
    if (this.stopped || this.state === "denied") return;
    if (this.socket && this.socket.readyState <= OPEN) return;
    if (!this.hasCredentials()) { this.setState("denied", "This iPad is not paired. Scan the QR code shown in LearnHarness (Draw → iPad)."); return; }
    this.clearTimer(this.retryTimer); this.retryTimer = undefined;
    this.setState("connecting");
    let socket: SocketLike;
    try { socket = this.options.createSocket(this.options.url); }
    catch { this.scheduleReconnect(); return; }
    this.socket = socket; this.authenticated = false;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      const token = this.token();
      this.lastHeard = this.now();
      this.raw({ t: "hello", v: PROTOCOL_VERSION, ...(token ? { device: token } : {}), ...(this.pairCode ? { pair: this.pairCode } : {}),
        name: this.options.name ?? "iPad" });
    };
    socket.onmessage = event => { if (this.socket === socket) this.message(event.data); };
    socket.onerror = () => {};
    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.socket = undefined; this.authenticated = false;
      this.clearTimer(this.pinger); this.pinger = undefined;
      // 4001 revoked / 4003 not paired: the key is useless, forget it.
      if (event.code === 4001 || event.code === 4003) {
        this.forget();
        if (this.state !== "denied") this.setState("denied", event.reason || "This iPad is no longer paired. Scan a new QR code.");
        return;
      }
      // 4004 too many devices / 4005 opened in another tab: keep the key; "Try again" retries.
      if (event.code === 4004 || event.code === 4005) {
        this.setState("denied", event.reason || "Connection refused.");
        return;
      }
      if (this.state === "denied") return;
      this.setState("offline", "Reconnecting…");
      this.scheduleReconnect();
    };
  }
  /** Reconnect immediately (page became visible / network came back). */
  wake(): void {
    if (this.stopped || this.state === "denied") return;
    if (this.socket && this.now() - this.lastHeard > DEAD_MS) this.drop();
    if (!this.socket) { this.attempts = 0; this.connect(); }
  }
  /** User-requested retry after a refusal (e.g. too many devices). */
  retry(): void { if (this.state === "denied") this.state = "offline"; this.attempts = 0; this.wake(); }
  /** Replace credentials with a freshly scanned pairing code. */
  pair(code: string): void { this.pairCode = code; this.state = "offline"; this.drop(); this.attempts = 0; this.connect(); }
  send(message: ClientMessage): boolean {
    if (!this.authenticated || this.socket?.readyState !== OPEN) return false;
    this.raw(message);
    return true;
  }
  stop(): void { this.stopped = true; this.clearTimer(this.retryTimer); this.drop(); }
  forget(): void { try { this.options.storage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } }

  private raw(message: ClientMessage): void { try { this.socket?.send(JSON.stringify(message)); } catch { this.drop(); } }
  private drop(): void {
    const socket = this.socket;
    this.socket = undefined; this.authenticated = false;
    this.clearTimer(this.pinger); this.pinger = undefined;
    if (socket) { socket.onclose = null; socket.onmessage = null; try { socket.close(); } catch { /* already closed */ } }
    if (!this.stopped && this.state !== "denied") { this.setState("offline", "Reconnecting…"); this.scheduleReconnect(); }
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer !== undefined) return;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.attempts++, 4));
    this.retryTimer = this.setTimer(() => { this.retryTimer = undefined; this.connect(); }, delay);
  }
  private heartbeat(): void {
    this.clearTimer(this.pinger);
    this.pinger = this.setTimer(() => {
      if (!this.socket) return;
      if (this.now() - this.lastHeard > DEAD_MS) { this.drop(); return; }
      this.raw({ t: "ping" });
      this.heartbeat();
    }, PING_MS);
  }
  private setState(state: ConnectionState, detail?: string): void { this.state = state; this.handlers.status(state, detail); }
  private message(data: unknown): void {
    this.lastHeard = this.now();
    let value: Record<string, unknown>;
    try { value = JSON.parse(String(data)); } catch { return; }
    if (!value || typeof value !== "object") return;
    switch (value.t) {
      case "welcome":
        if (typeof value.device === "string") {
          try { this.options.storage.setItem(TOKEN_KEY, value.device); } catch { /* private mode: pairs per tab */ }
        }
        this.pairCode = undefined; this.authenticated = true; this.attempts = 0;
        this.setState("online");
        this.heartbeat();
        this.handlers.welcome?.(typeof value.build === "string" ? value.build : undefined);
        return;
      case "denied":
        this.pairCode = undefined;
        // The server closes next: 4003 (not paired: forget the token) or 4004 (busy).
        this.setState("denied", typeof value.reason === "string" ? value.reason.slice(0, 300) : "Connection refused.");
        return;
      case "state":
        try { this.handlers.state(value.doc === null ? null : parseDocSnapshot(value.doc), value.host === true); }
        catch { this.raw({ t: "sync" }); }
        return;
      case "op":
        try { this.handlers.op(parseOpMessage(value)); } catch { this.raw({ t: "sync" }); }
        return;
      case "reject":
        if (typeof value.id === "string") this.handlers.reject(value.id, typeof value.reason === "string" ? value.reason : "Rejected.");
        return;
    }
  }
}
