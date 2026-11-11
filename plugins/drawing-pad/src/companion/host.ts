/** Desktop-window half of the iPad companion. The window's `Sheets` stay the single
 * source of truth (they are what the existing submission interceptor exports), so:
 *  - every committed change to the targeted sheet is diffed into a small operation
 *    (push / pop / reset) and published to the backend relay, in order;
 *  - companion intents (stroke / undo / redo / clear) are applied through the same
 *    Sheets methods the desktop toolbar uses, after checking they target this exact
 *    sheet (window instance + session + sheet id), so a stale device can never draw
 *    into another session's or question's sheet;
 *  - in-progress companion strokes are shown as non-content live previews. */
import type { PluginFrontendContext, PluginNotification } from "learnharness-plugin-api";
import type { SessionSheet, Sheets } from "../state.ts";
import type { Stroke } from "../strokes.ts";
import { appPalette } from "../theme.ts";
import { fromWire, isDocId, isId, LIMITS, toWire, validPoints, type DocOp, type DocSnapshot, type Intent, type LiveMessage, type WireStroke } from "./protocol.ts";
import type { CompanionStatus } from "./backend.ts";

const LIVE_TIMEOUT_MS = 5_000, ALIVE_MS = 15_000;
/** Bounds for what a paired device can make this window hold in memory. */
export const MAX_LIVE_PER_DEVICE = 2, MAX_DOCUMENT_POINTS = 1_000_000, MAX_APPLIED_IDS = 50_000;
interface Published { doc: string; rev: number; strokes: readonly Stroke[]; redo: number; meta: string }
interface Live { key: string; doc: string; stroke: Stroke; timer: ReturnType<typeof setTimeout> }

export function randomId(): string {
  const bytes = new Uint8Array(12); crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
/** Pure diff between the last published sheet and the current one. */
export function diffStrokes(previous: readonly Stroke[], next: readonly Stroke[]): "same" | "push" | "pop" | "reset" {
  const prefix = (length: number) => { for (let i = 0; i < length; i++) if (previous[i] !== next[i]) return false; return true; };
  if (next.length === previous.length && prefix(next.length)) return "same";
  if (next.length === previous.length + 1 && prefix(previous.length)) return "push";
  if (next.length === previous.length - 1 && prefix(next.length)) return "pop";
  return "reset";
}

export class CompanionHost {
  readonly instance = randomId();
  status: CompanionStatus | undefined;
  private target: SessionSheet | undefined;
  private claim = false;
  /** When Draw was last opened in this window; the newest claim wins ownership. */
  private claimedAt = 0;
  /** Another window owns the companion sheet; stay quiet until Draw opens here. */
  private passive = false;
  private published: Published | null | undefined;
  private readonly ids = new WeakMap<Stroke, string>();
  /** Companion stroke ids ever applied to each sheet, so a stroke resent after a
   * reconnect is never applied twice, even if it was since undone or cleared. */
  private readonly applied = new WeakMap<SessionSheet, { draft: number; ids: Set<string> }>();
  private alive: ReturnType<typeof setInterval> | undefined;
  private readonly live = new Map<string, Live>();
  private readonly statusListeners = new Set<() => void>();
  private pumping = false;
  private dirty = false;
  private forceState = false;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  /** `ensureSheet` gives the targeted session a blank sheet when it has none while a
   * device is connected, so the iPad can keep writing with the Draw panel closed. */
  constructor(private readonly ctx: PluginFrontendContext, private readonly sheets: Sheets,
    private readonly ensureSheet?: (state: SessionSheet) => void) {
    this.cleanups.push(sheets.onChange(() => this.schedule()));
    this.cleanups.push(ctx.onNotification(event => this.notification(event)));
    this.cleanups.push(ctx.onResync(() => { void this.refreshStatus(); this.schedule(true); }));
    // Liveness for the backend: a reloaded/closed window stops owning the sheet, so
    // devices are told to wait instead of drawing into a sheet that nobody holds.
    this.alive = setInterval(() => {
      if (this.running && this.target && !this.passive) void this.ctx.call<{ ignored?: boolean }>("companion-alive", { host: this.instance })
        // Ownership lapsed (sleep, throttled timers): republish to take it back.
        .then(result => { if (result?.ignored) this.schedule(true); }, () => {});
    }, ALIVE_MS);
    (this.alive as { unref?: () => void }).unref?.();
    void this.refreshStatus();
  }
  get running(): boolean { return !!this.status?.running; }
  get connectedDevices(): number { return this.status?.devices.filter(device => device.connected).length ?? 0; }
  get targetSession(): SessionSheet | undefined { return this.target; }
  onStatus(listener: () => void): () => void { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener); }; }

  /** The user opened Draw for this session in this window: companions follow it. */
  focus(state: SessionSheet): void {
    if (this.target !== state) this.clearLive();
    this.target = state; this.claim = true; this.passive = false; this.claimedAt = Date.now();
    this.schedule(true);
  }
  docId(state: SessionSheet | undefined = this.target): string | undefined {
    const draft = state?.draft;
    if (!state || !draft) return undefined;
    const id = `${this.instance}.${state.id}.${draft.id}`;
    return isDocId(id) ? id : undefined;
  }
  async call<T>(operation: string, input?: unknown): Promise<T> {
    const result = await this.ctx.call<T>(operation, input);
    if (operation !== "companion-pair" && result && typeof result === "object" && "running" in result) this.setStatus(result as unknown as CompanionStatus);
    if (operation === "companion-start") this.schedule(true);
    return result;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.alive);
    this.clearLive();
    // Best effort: release ownership so devices stop drawing into this window's sheet.
    if (this.running && !this.passive) void this.ctx.call("companion-publish", { host: this.instance, release: true }).catch(() => {});
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.statusListeners.clear();
  }

  private async refreshStatus(): Promise<void> {
    try { this.setStatus(await this.ctx.call<CompanionStatus>("companion-status")); }
    catch { /* Older backend or disabled plugin: the companion simply stays unavailable. */ }
  }
  private setStatus(status: CompanionStatus): void {
    if (this.disposed || !status || typeof status !== "object") return;
    const wasRunning = this.running, wasConnected = this.connectedDevices;
    this.status = status;
    if (status.running && !wasRunning) this.schedule(true);
    else if (this.connectedDevices > 0 && !wasConnected) this.schedule();
    if (!status.running) { this.published = undefined; this.clearLive(); }
    for (const listener of this.statusListeners) listener();
  }
  private notification(event: PluginNotification): void {
    if (this.disposed || event.pluginId !== this.ctx.manifest.id) return;
    const data = event.data as Record<string, unknown> | undefined;
    switch (event.topic) {
      case "companion-status": this.setStatus(event.data as CompanionStatus); return;
      case "companion-need-state": this.schedule(true); return;
      case "companion-intent": if (data && typeof data === "object" && isId(data.device)) this.intent(data.intent as Intent, data.device); return;
      case "companion-live": if (data && typeof data === "object" && isId(data.device)) this.liveMessage(data.message as LiveMessage, data.device); return;
    }
  }

  // ---- desktop → companion -------------------------------------------------
  private schedule(full = false): void {
    if (this.disposed) return;
    this.dirty = true; if (full) this.forceState = true;
    if (!this.pumping) void this.pump();
  }
  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.dirty && !this.disposed) {
        this.dirty = false;
        if (!this.running || !this.target || (this.passive && !this.claim)) { if (!this.running) this.published = undefined; this.forceState = false; continue; }
        if (!this.target.draft && this.connectedDevices > 0 && !this.passive) this.ensureSheet?.(this.target);
        const message = this.nextMessage();
        if (!message) continue;
        try {
          const result = await this.ctx.call<{ resync?: boolean; ignored?: boolean }>("companion-publish", { host: this.instance, ...message });
          if (result?.resync) { this.forceState = true; this.dirty = true; }
          // A reply to an older publish must not undo a claim made meanwhile.
          if (result?.ignored) { this.published = undefined; if (!this.claim) this.passive = true; }
        } catch {
          // Backend unavailable/disabled: publish a complete state (keeping any claim) later.
          this.published = undefined;
          if (message.claim) this.claim = true;
        }
      }
    } finally { this.pumping = false; }
  }
  private strokeId(stroke: Stroke): string {
    let id = this.ids.get(stroke);
    if (!id) { id = stroke.id && isId(stroke.id) ? stroke.id : `d${randomId()}`; this.ids.set(stroke, id); }
    return id;
  }
  private wire(stroke: Stroke): WireStroke { return toWire(stroke, this.strokeId(stroke)); }
  private snapshot(rev: number): DocSnapshot | null {
    const state = this.target, draft = state?.draft, id = this.docId(state);
    if (!state || !draft || !id) return null;
    return { id, rev, kind: state.kind, label: draft.reference?.label ?? "Blank sheet", width: draft.width, height: draft.height,
      background: draft.background, backgroundColor: draft.backgroundColor, mode: appPalette().mode,
      strokes: draft.strokes.map(stroke => this.wire(stroke)), redo: draft.redo?.length ?? 0 };
  }
  private nextMessage(): Record<string, unknown> | undefined {
    const state = this.target!, draft = state.draft, doc = this.docId(state);
    const claim = this.claim;
    if (!draft || !doc) {
      if (this.published === null && !this.forceState) return undefined;
      this.published = null; this.forceState = false; this.claim = false;
      return { state: null, claimedAt: this.claimedAt, ...(claim ? { claim } : {}) };
    }
    const meta = JSON.stringify([draft.background.length, draft.background.slice(-64), draft.backgroundColor, draft.width, draft.height,
      draft.palette ?? "", draft.reference?.label ?? ""]);
    const previous = this.published, redo = draft.redo?.length ?? 0;
    if (previous?.doc !== doc) this.clearLive();
    if (!this.forceState && previous && previous.doc === doc && previous.meta === meta) {
      const diff = diffStrokes(previous.strokes, draft.strokes);
      if (diff === "same" && previous.redo === redo) return undefined;
      const op: DocOp = diff === "push" ? { k: "push", stroke: this.wire(draft.strokes.at(-1)!) } : diff === "pop" ? { k: "pop" }
        : { k: "reset", strokes: draft.strokes.map(stroke => this.wire(stroke)) };
      const rev = previous.rev + 1;
      this.published = { doc, rev, strokes: draft.strokes, redo, meta };
      return { op: { t: "op", doc, rev, op, redo } };
    }
    const rev = previous && previous.doc === doc ? previous.rev : 0;
    this.published = { doc, rev, strokes: draft.strokes, redo, meta };
    this.forceState = false; this.claim = false;
    return { state: this.snapshot(rev), claimedAt: this.claimedAt, ...(claim ? { claim } : {}) };
  }

  // ---- companion → desktop -------------------------------------------------
  private reject(doc: string, id: string, reason: string): void {
    void this.ctx.call("companion-reject", { host: this.instance, doc, id, reason }).catch(() => {});
  }
  private intent(intent: Intent, device: string): void {
    if (!intent || typeof intent !== "object" || !isDocId(intent.doc)) return;
    const state = this.target, doc = this.docId(state);
    if (!state || !doc || intent.doc !== doc || !state.draft) {
      // Not for this window's current sheet. Only this window's own stale docs get a
      // reply (another window may own the sheet); the device then resynchronizes.
      if (intent.doc.startsWith(`${this.instance}.`)) {
        if (intent.t === "stroke" && isId(intent.stroke?.id)) {
          this.endLive(`${device}:${intent.stroke.id}`);
          this.reject(intent.doc, intent.stroke.id, "This drawing changed on the computer.");
        }
        this.schedule(true);
      }
      return;
    }
    const draft = state.draft;
    switch (intent.t) {
      case "stroke": {
        const wire = intent.stroke;
        if (!wire || !isId(wire.id) || (wire.tool !== "pen" && wire.tool !== "eraser") || !validPoints(wire.pts, LIMITS.pointsPerStroke)) return;
        this.endLive(`${device}:${wire.id}`);
        // Idempotent: a device may resend a stroke after reconnecting.
        let applied = this.applied.get(state);
        if (!applied || applied.draft !== draft.id) this.applied.set(state, applied = { draft: draft.id, ids: new Set() });
        if (applied.ids.has(wire.id)) {
          // Still on the sheet: its push is on the way. Otherwise it was undone or cleared
          // meanwhile; tell the device to drop it rather than resend it forever.
          if (!draft.strokes.some(stroke => this.ids.get(stroke) === wire.id))
            this.reject(doc, wire.id, "That stroke was already removed on the computer.");
          return;
        }
        const points = draft.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
        if (draft.strokes.length >= LIMITS.strokesPerDocument || points + wire.pts.length / 3 > MAX_DOCUMENT_POINTS) {
          this.reject(doc, wire.id, "This drawing is full. Clear it to continue."); return;
        }
        const stroke = fromWire(wire);
        this.ids.set(stroke, wire.id);
        applied.ids.add(wire.id);
        if (applied.ids.size > MAX_APPLIED_IDS) applied.ids.delete(applied.ids.values().next().value!);
        this.sheets.update(state, [...draft.strokes, stroke]);
        return;
      }
      case "undo": this.sheets.undo(state); return;
      case "redo": this.sheets.redo(state); return;
      case "clear": this.sheets.clear(state); return;
    }
  }
  private liveMessage(message: LiveMessage, device: string): void {
    if (!message || typeof message !== "object" || !isId(message.sid)) return;
    const key = `${device}:${message.sid}`;
    // End previews by key whatever sheet they were for, so none linger on a new sheet.
    if (message.t === "live-end") { this.endLive(key); return; }
    const state = this.target, doc = this.docId(state);
    if (!state || !doc || message.doc !== doc) return;
    if (message.t !== "live" || !validPoints(message.pts, LIMITS.livePointsPerMessage) || !Number.isSafeInteger(message.from)) return;
    let live = this.live.get(key);
    if (!live) {
      if (message.from !== 0) return; // missed the start; the committed stroke will arrive anyway
      // At most a couple of concurrent previews per device (a pencil draws one stroke).
      const own = [...this.live.keys()].filter(other => other.startsWith(`${device}:`));
      for (const old of own.slice(0, Math.max(0, own.length - MAX_LIVE_PER_DEVICE + 1))) this.endLive(old);
      live = { key, doc, stroke: { tool: message.tool, points: [], ...(message.size === 1 ? {} : { size: message.size }) }, timer: setTimeout(() => {}, 0) };
      this.live.set(key, live);
    }
    const points = live.stroke.points;
    if (message.from > points.length || message.from + message.pts.length / 3 > LIMITS.pointsPerStroke) return;
    clearTimeout(live.timer);
    live.timer = setTimeout(() => this.endLive(key), LIVE_TIMEOUT_MS);
    points.length = message.from;
    for (let i = 0; i + 2 < message.pts.length; i += 3) points.push({ x: message.pts[i]!, y: message.pts[i + 1]!, pressure: message.pts[i + 2]! });
    this.sheets.setLive(state, key, { ...live.stroke, points });
  }
  private endLive(key: string): void {
    const live = this.live.get(key);
    if (!live) return;
    clearTimeout(live.timer); this.live.delete(key);
    if (this.target) this.sheets.setLive(this.target, key, undefined);
  }
  private clearLive(): void {
    for (const live of this.live.values()) clearTimeout(live.timer);
    this.live.clear();
    if (this.target) this.sheets.clearLive(this.target);
  }
}
