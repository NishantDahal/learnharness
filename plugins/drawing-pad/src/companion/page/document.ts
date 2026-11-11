/** The iPad's mirror of the desktop-owned drawing (pure, DOM-free).
 * Committed strokes come only from the desktop (state snapshots and ordered ops).
 * Strokes drawn here stay "pending" (shown optimistically) until the desktop's
 * committed push with the same id arrives; they are resent after reconnecting and
 * dropped (never redirected) if the desktop switched to a different sheet. */
import { applyOp, fromWire, type DocSnapshot, type OpMessage, type WireStroke } from "../protocol.ts";
import type { Stroke } from "../../strokes.ts";

export interface Pending { doc: string; wire: WireStroke; stroke: Stroke }
export class CompanionDocument {
  doc: DocSnapshot | null = null;
  /** Whether the server has heard from a desktop window at all. */
  host = false;
  known = false;
  private committed: WireStroke[] = [];
  private strokes: Stroke[] = [];
  pending: Pending[] = [];
  /** Pending strokes dropped because the sheet changed; reported once to the UI. */
  dropped = 0;

  get id(): string | undefined { return this.doc?.id; }
  get rev(): number { return this.doc?.rev ?? 0; }
  get redo(): number { return this.doc?.redo ?? 0; }
  get canUndo(): boolean { return this.committed.length > 0; }
  committedStrokes(): readonly Stroke[] { return this.strokes; }
  /** Committed ink followed by optimistic local strokes, in drawing order. */
  displayStrokes(): Stroke[] { return [...this.strokes, ...this.pending.map(pending => pending.stroke)]; }

  /** Full snapshot. Returns the pending strokes that must be (re)sent to the desktop. */
  applyState(doc: DocSnapshot | null, host: boolean): { docChanged: boolean; resend: WireStroke[] } {
    const docChanged = doc?.id !== this.doc?.id;
    this.doc = doc; this.host = host; this.known = true;
    this.committed = doc ? [...doc.strokes] : [];
    this.strokes = this.committed.map(fromWire);
    const committedIds = new Set(this.committed.map(stroke => stroke.id));
    const kept: Pending[] = [];
    for (const pending of this.pending) {
      // Strokes for another sheet are discarded, never attached to the new question.
      if (!doc || pending.doc !== doc.id) this.dropped++;
      else if (!committedIds.has(pending.wire.id)) kept.push(pending);
    }
    this.pending = kept;
    return { docChanged, resend: kept.map(pending => pending.wire) };
  }

  /** One committed operation. "resync" means a gap or foreign sheet: request state. */
  applyOp(message: OpMessage): "ok" | "resync" | "ignored" {
    const doc = this.doc;
    if (!doc || message.doc !== doc.id) return "resync";
    if (message.rev <= doc.rev) return "ignored"; // duplicate after a snapshot
    if (message.rev !== doc.rev + 1) return "resync";
    this.committed = applyOp(this.committed, message.op);
    if (message.op.k === "push") {
      const id = message.op.stroke.id;
      this.pending = this.pending.filter(pending => pending.wire.id !== id);
      this.strokes = [...this.strokes, fromWire(message.op.stroke)];
    } else this.strokes = this.committed.map(fromWire);
    if (message.op.k === "reset") {
      const ids = new Set(this.committed.map(stroke => stroke.id));
      this.pending = this.pending.filter(pending => !ids.has(pending.wire.id));
    }
    this.doc = { ...doc, rev: message.rev, redo: message.redo, strokes: this.committed };
    return "ok";
  }
  addPending(wire: WireStroke): Pending | undefined {
    if (!this.doc) return undefined;
    const pending = { doc: this.doc.id, wire, stroke: fromWire(wire) };
    this.pending.push(pending);
    return pending;
  }
  reject(id: string): boolean {
    const before = this.pending.length;
    this.pending = this.pending.filter(pending => pending.wire.id !== id);
    return this.pending.length !== before;
  }
  takeDropped(): number { const dropped = this.dropped; this.dropped = 0; return dropped; }
}
