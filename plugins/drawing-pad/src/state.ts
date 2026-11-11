import { DEFAULT_DARK_INK_COLOR, DEFAULT_IMAGE_SCALE } from "./settings.ts";
import type { Reference } from "./reference.ts";
import { inkSignature, visibleStrokes, type Stroke, type Tool } from "./strokes.ts";

export interface Draft {
  id: number;
  revision: number;
  /** Raster of the reference alone; empty on blank sheets. No viewport baked in. */
  background: string;
  backgroundColor: string;
  /** Ink paired with this raster, independent of other pending sheet repaints. */
  color: string;
  /** Original learner-visible content and the palette used for this raster. */
  reference?: Reference;
  palette?: string;
  width: number;
  height: number;
  pixelRatio: number;
  strokes: Stroke[];
  /** Strokes removed by Undo, most recent last. Any other edit or Clear empties it. */
  redo?: Stroke[];
  hasInk: boolean;
}
export interface SessionSheet {
  readonly id: string;
  readonly kind: "teaching" | "practice";
  draft?: Draft;
  tool: Tool;
  pan: { x: number; y: number };
  readonly seenPoses: Set<string>;
  sentSignature: string;
  readTicket: number;
}
export interface Capture { session: SessionSheet; draft: Draft; signature: string; color: string; imageScale: number; sendImage: boolean }

/** Window-owned only. No storage, navigation parsing, or host input reconstruction. */
export class Sheets {
  readonly sessions = new Map<string, SessionSheet>();
  color = DEFAULT_DARK_INK_COLOR;
  imageScale = DEFAULT_IMAGE_SCALE;
  private nextId = 0;
  private readonly listeners = new Set<() => void>();
  private readonly signatures = new WeakMap<Draft, string>();
  /** In-progress remote (companion) strokes: presentation only, never content. */
  private readonly live = new Map<SessionSheet, Map<string, Stroke>>();
  private readonly liveListeners = new Set<() => void>();
  constructor(private readonly changed: () => void, private readonly newProblem: (session: SessionSheet) => void,
    private readonly currentColor: () => string = () => this.color) {}
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Remote in-progress strokes changed (high frequency; listeners should coalesce). */
  onLive(listener: () => void): () => void { this.liveListeners.add(listener); return () => { this.liveListeners.delete(listener); }; }
  private publish(): void { this.changed(); for (const listener of this.listeners) listener(); }
  session(id: string, kind: SessionSheet["kind"]): SessionSheet {
    let state = this.sessions.get(id);
    if (!state) {
      state = { id, kind, tool: "pen", pan: { x: 0, y: 0 }, seenPoses: new Set(), sentSignature: "", readTicket: 0 };
      this.sessions.set(id, state);
    }
    if (state.kind !== kind) throw new Error("Drawing session kind changed.");
    return state;
  }
  setColor(color: string): void {
    if (this.color === color && [...this.sessions.values()].every(state => !state.draft || state.draft.color === color)) return;
    this.color = color;
    for (const state of this.sessions.values()) if (state.draft && state.draft.color !== color)
      state.draft = { ...state.draft, color, revision: state.draft.revision + 1 };
    this.publish();
  }
  /** Accepted preferences can recolor already-current sheets without waiting
   * for unrelated reference work. Older rasters retain their own paired ink. */
  setInkForPalette(color: string, palette: string): void {
    let changed = false;
    for (const state of this.sessions.values()) if (state.draft?.palette === palette && state.draft.color !== color) {
      state.draft = { ...state.draft, color, revision: state.draft.revision + 1 }; changed = true;
    }
    if (changed) this.publish();
  }
  /** Atomically pair re-rendered reference backgrounds with their matching ink.
   * Merge into the latest draft so work drawn during rasterization is retained. */
  setPalette(color: string, palette: string, backgrounds: ReadonlyMap<SessionSheet, { id: number; background: string; backgroundColor: string }>): void {
    const recolor = this.color !== color;
    let changed = recolor;
    this.color = color;
    for (const state of this.sessions.values()) {
      const draft = state.draft, background = backgrounds.get(state);
      if (!draft) continue;
      const repaint = background?.id === draft.id && draft.palette !== palette;
      if (repaint || (draft.palette === palette && draft.color !== color)) {
        state.draft = { ...draft, color, ...(repaint ? { background: background.background,
          backgroundColor: background.backgroundColor, palette } : {}), revision: draft.revision + 1 };
        changed = true;
      }
    }
    if (changed) this.publish();
  }
  /** Delivery resolution is not a drawing edit and does not trigger practice resends. */
  setImageScale(imageScale: number): void { this.imageScale = imageScale; }
  create(state: SessionSheet, sheet: Omit<Draft, "id" | "revision" | "strokes" | "hasInk" | "color">): Draft {
    const draft = { ...sheet, color: this.currentColor(), id: ++this.nextId, revision: 0, strokes: [], redo: [], hasInk: false };
    state.draft = draft;
    state.pan = { x: 0, y: 0 };
    this.publish();
    return draft;
  }
  /** A content edit. Unless a redo stack is supplied (Undo/Redo), it discards Redo. */
  update(state: SessionSheet, strokes: Stroke[], redo: Stroke[] = []): void {
    if (!state.draft) return;
    state.draft = { ...state.draft, revision: state.draft.revision + 1, strokes, redo, hasInk: visibleStrokes(strokes).length > 0 };
    this.publish();
  }
  setTool(state: SessionSheet, tool: Tool): void { state.tool = tool; this.publish(); }
  /** Camera movement is not a content edit and cannot invalidate an acceptance. */
  setPan(state: SessionSheet, pan: SessionSheet["pan"]): void { state.pan = pan; this.publish(); }
  undo(state: SessionSheet): void {
    const draft = state.draft;
    if (draft?.strokes.length) this.update(state, draft.strokes.slice(0, -1), [...(draft.redo ?? []), draft.strokes.at(-1)!]);
  }
  redo(state: SessionSheet): void {
    const redo = state.draft?.redo;
    if (state.draft && redo?.length) this.update(state, [...state.draft.strokes, redo.at(-1)!], redo.slice(0, -1));
  }
  canRedo(state: SessionSheet): boolean { return !!state.draft?.redo?.length; }
  /** Clear is not undoable (unchanged behavior); it also discards Redo. */
  clear(state: SessionSheet): void { if (state.draft?.strokes.length || state.draft?.redo?.length) this.update(state, []); }
  /** Show (or, with `undefined`, remove) a remote stroke still being drawn. This only
   * repaints mounted sheets: it is not an edit, revision, Undo entry or submission. */
  setLive(state: SessionSheet, key: string, stroke: Stroke | undefined): void {
    let strokes = this.live.get(state);
    if (stroke) { if (!strokes) this.live.set(state, strokes = new Map()); strokes.set(key, stroke); }
    else if (!strokes?.delete(key)) return;
    if (strokes && !strokes.size) this.live.delete(state);
    for (const listener of this.liveListeners) listener();
  }
  clearLive(state?: SessionSheet): void {
    if (state ? !this.live.delete(state) : !this.live.size) return;
    if (!state) this.live.clear();
    for (const listener of this.liveListeners) listener();
  }
  liveStrokes(state: SessionSheet): Stroke[] { return [...(this.live.get(state)?.values() ?? [])]; }
  dropUntouched(state: SessionSheet): void {
    // A sheet with only Redo history was touched; keep it so Redo still works.
    if (state.draft && !state.draft.strokes.length && !state.draft.redo?.length) { state.draft = undefined; this.publish(); }
  }
  signature(state: SessionSheet): string {
    const draft = state.draft;
    if (!draft?.hasInk) return "";
    const cached = this.signatures.get(draft);
    if (cached !== undefined) return cached;
    const ink = inkSignature(draft.strokes, draft.color);
    const signature = ink ? `${draft.id}:${draft.palette ?? ""}:${ink}` : "";
    this.signatures.set(draft, signature);
    return signature;
  }
  pending(state: SessionSheet): boolean {
    const signature = this.signature(state);
    return !!signature && (state.kind === "teaching" || signature !== state.sentSignature);
  }
  capture(state: SessionSheet): Capture | undefined {
    const draft = state.draft;
    if (!draft) return undefined;
    const signature = this.signature(state);
    return { session: state, draft, color: draft.color, imageScale: this.imageScale, signature,
      sendImage: !!signature && (state.kind === "teaching" || signature !== state.sentSignature) };
  }
  accepted(captured: Capture): void {
    const state = captured.session;
    if (state.draft?.id !== captured.draft.id) return; // A new problem/sheet supersedes this acceptance.
    if (state.kind === "practice") {
      if (captured.sendImage) { state.sentSignature = captured.signature; this.publish(); }
      return;
    }
    if (state.draft.revision === captured.draft.revision) this.update(state, []);
  }
  /** Only accepted pose identities count. Conclusion/dismissal never reach this reset. */
  observePoses(state: SessionSheet, poses: readonly string[], baseline = false): boolean {
    if (state.kind !== "practice") return false;
    const latest = poses.at(-1);
    const newLatest = latest !== undefined && !state.seenPoses.has(latest);
    for (const pose of poses) state.seenPoses.add(pose);
    if (!newLatest || baseline) return false;
    state.draft = undefined;
    state.sentSignature = "";
    state.tool = "pen";
    state.pan = { x: 0, y: 0 };
    this.newProblem(state);
    this.publish();
    return true;
  }
  dispose(): void { this.sessions.clear(); this.listeners.clear(); this.live.clear(); this.liveListeners.clear(); }
}
