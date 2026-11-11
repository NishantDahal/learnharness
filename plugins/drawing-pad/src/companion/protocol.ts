/** Wire protocol shared by the desktop bridge, the LAN companion server and the
 * iPad page. Pure code: no DOM, no Node. Every message from the network is parsed
 * with these strict validators before it can reach drawing state. */
import { BRUSH_SIZES, type Point, type Stroke } from "../strokes.ts";

export const PROTOCOL_VERSION = 1;
export const LIMITS = Object.freeze({
  /** Maximum WebSocket frame accepted from a companion device. */
  messageBytes: 512 * 1024,
  pointsPerStroke: 20_000,
  livePointsPerMessage: 2_000,
  strokesPerDocument: 20_000,
  /** World coordinates are CSS pixels around the reference center. */
  coordinate: 1_000_000,
  idLength: 64,
  nameLength: 60,
});
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DOC_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/** Flattened `[x, y, pressure, …]`; x/y rounded to 0.01 CSS px, pressure to 0.001. */
export interface WireStroke { id: string; tool: "pen" | "eraser"; size: number; pts: number[] }
export interface DocSnapshot {
  /** Opaque identity of one drawing sheet: host window instance + session + sheet. */
  id: string;
  /** Number of committed operations in this sheet as seen by the companion. */
  rev: number;
  kind: "teaching" | "practice";
  /** Learner-visible reference label ("Question", "Problem", …) or "Blank sheet". */
  label: string;
  /** Frozen reference size in world CSS pixels; 0×0 for a blank sheet. */
  width: number;
  height: number;
  /** PNG data URL of the frozen learner-visible reference, or "". */
  background: string;
  backgroundColor: string;
  mode: "light" | "dark";
  strokes: WireStroke[];
  /** Redo depth. Redo contents stay on the desktop. */
  redo: number;
}
export type DocOp = { k: "push"; stroke: WireStroke } | { k: "pop" } | { k: "reset"; strokes: WireStroke[] };
export interface OpMessage { t: "op"; doc: string; rev: number; op: DocOp; redo: number }

export type ClientMessage =
  | { t: "hello"; v: number; pair?: string; device?: string; name?: string }
  | { t: "stroke"; doc: string; stroke: WireStroke }
  | { t: "live"; doc: string; sid: string; tool: "pen" | "eraser"; size: number; from: number; pts: number[] }
  | { t: "live-end"; doc: string; sid: string }
  | { t: "undo" | "redo" | "clear"; doc: string }
  | { t: "sync" }
  | { t: "ping" };
/** Intents forwarded from the companion server to the desktop window. */
export type Intent = Extract<ClientMessage, { t: "stroke" | "undo" | "redo" | "clear" }>;
export type LiveMessage = Extract<ClientMessage, { t: "live" | "live-end" }>;

export type ServerMessage =
  | { t: "welcome"; deviceId: string; name: string; build?: string; device?: string }
  | { t: "denied"; reason: string }
  | { t: "state"; doc: DocSnapshot | null; host: boolean }
  | OpMessage
  | { t: "reject"; id: string; reason: string }
  | { t: "pong" };

const round = (value: number, places: number) => { const f = 10 ** places; return Math.round(value * f) / f; };
export function toWire(stroke: Stroke, id: string): WireStroke {
  const pts: number[] = [];
  for (const point of stroke.points) pts.push(round(point.x, 2), round(point.y, 2), round(point.pressure, 3));
  return { id, tool: stroke.tool, size: stroke.size ?? 1, pts };
}
export function fromWire(wire: WireStroke): Stroke {
  const points: Point[] = [];
  for (let i = 0; i + 2 < wire.pts.length; i += 3) points.push({ x: wire.pts[i]!, y: wire.pts[i + 1]!, pressure: wire.pts[i + 2]! });
  return { tool: wire.tool, points, id: wire.id, ...(wire.size === 1 ? {} : { size: wire.size }) };
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  // Object.prototype.hasOwnProperty (not Object.hasOwn) keeps Safari 15.0–15.3 working.
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && keys.every(key => required.includes(key) || optional.includes(key));
}
export function isId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
export function isDocId(value: unknown): value is string { return typeof value === "string" && DOC_ID.test(value); }
export function isToken(value: unknown): value is string { return typeof value === "string" && TOKEN.test(value); }
function isTool(value: unknown): value is "pen" | "eraser" { return value === "pen" || value === "eraser"; }
export function isBrushSize(value: unknown): value is number { return (BRUSH_SIZES as readonly unknown[]).includes(value); }
/** Validates flattened point triples: finite, bounded coordinates, pressure in [0, 1]. */
export function validPoints(pts: unknown, maxPoints: number, allowEmpty = false): pts is number[] {
  if (!Array.isArray(pts) || pts.length % 3 !== 0 || pts.length > maxPoints * 3 || (!allowEmpty && !pts.length)) return false;
  for (let i = 0; i < pts.length; i++) {
    const value = pts[i];
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (i % 3 === 2 ? value < 0 || value > 1 : Math.abs(value) > LIMITS.coordinate) return false;
  }
  return true;
}
export function parseWireStroke(value: unknown): WireStroke {
  if (!isObject(value) || !exactKeys(value, ["id", "tool", "size", "pts"]) || !isId(value.id) || !isTool(value.tool) ||
    !isBrushSize(value.size) || !validPoints(value.pts, LIMITS.pointsPerStroke)) throw new Error("Invalid stroke.");
  return { id: value.id, tool: value.tool, size: value.size, pts: [...value.pts] };
}
/** Strict parser for untrusted companion-device frames. Throws on anything else. */
export function parseClientMessage(raw: string): ClientMessage {
  if (raw.length > LIMITS.messageBytes) throw new Error("Message too large.");
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || typeof value.t !== "string") throw new Error("Invalid message.");
  switch (value.t) {
    case "hello": {
      if (!exactKeys(value, ["t", "v"], ["pair", "device", "name"]) || value.v !== PROTOCOL_VERSION ||
        (value.pair !== undefined && !isToken(value.pair)) || (value.device !== undefined && !isToken(value.device)) ||
        (value.name !== undefined && (typeof value.name !== "string" || value.name.length > LIMITS.nameLength)))
        throw new Error("Invalid hello.");
      return { t: "hello", v: value.v, ...(value.pair ? { pair: value.pair as string } : {}),
        ...(value.device ? { device: value.device as string } : {}), ...(value.name !== undefined ? { name: cleanName(value.name as string) } : {}) };
    }
    case "stroke":
      if (!exactKeys(value, ["t", "doc", "stroke"]) || !isDocId(value.doc)) throw new Error("Invalid stroke message.");
      return { t: "stroke", doc: value.doc, stroke: parseWireStroke(value.stroke) };
    case "live":
      if (!exactKeys(value, ["t", "doc", "sid", "tool", "size", "from", "pts"]) || !isDocId(value.doc) || !isId(value.sid) ||
        !isTool(value.tool) || !isBrushSize(value.size) || !Number.isSafeInteger(value.from) || (value.from as number) < 0 ||
        (value.from as number) >= LIMITS.pointsPerStroke || !validPoints(value.pts, LIMITS.livePointsPerMessage))
        throw new Error("Invalid live message.");
      return { t: "live", doc: value.doc, sid: value.sid, tool: value.tool, size: value.size, from: value.from as number, pts: [...value.pts] };
    case "live-end":
      if (!exactKeys(value, ["t", "doc", "sid"]) || !isDocId(value.doc) || !isId(value.sid)) throw new Error("Invalid live-end message.");
      return { t: "live-end", doc: value.doc, sid: value.sid };
    case "undo": case "redo": case "clear":
      if (!exactKeys(value, ["t", "doc"]) || !isDocId(value.doc)) throw new Error("Invalid edit message.");
      return { t: value.t, doc: value.doc };
    case "sync": case "ping":
      if (!exactKeys(value, ["t"])) throw new Error("Invalid message.");
      return { t: value.t };
    default: throw new Error("Unknown message.");
  }
}
export function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, LIMITS.nameLength) || "iPad";
}
export function parseDocSnapshot(value: unknown): DocSnapshot {
  if (!isObject(value) || !exactKeys(value, ["id", "rev", "kind", "label", "width", "height", "background", "backgroundColor", "mode", "strokes", "redo"]) ||
    !isDocId(value.id) || !Number.isSafeInteger(value.rev) || (value.rev as number) < 0 ||
    (value.kind !== "teaching" && value.kind !== "practice") || typeof value.label !== "string" || value.label.length > 80 ||
    typeof value.width !== "number" || !(value.width >= 0 && value.width <= 100_000) ||
    typeof value.height !== "number" || !(value.height >= 0 && value.height <= 100_000) ||
    typeof value.background !== "string" || (value.background !== "" && !value.background.startsWith("data:image/png;base64,")) ||
    typeof value.backgroundColor !== "string" || value.backgroundColor.length > 100 ||
    (value.mode !== "light" && value.mode !== "dark") || !Array.isArray(value.strokes) || value.strokes.length > LIMITS.strokesPerDocument ||
    !Number.isSafeInteger(value.redo) || (value.redo as number) < 0) throw new Error("Invalid drawing snapshot.");
  return { ...(value as unknown as DocSnapshot), strokes: value.strokes.map(parseWireStroke) };
}
export function parseOp(value: unknown): DocOp {
  if (!isObject(value)) throw new Error("Invalid operation.");
  if (value.k === "push" && exactKeys(value, ["k", "stroke"])) return { k: "push", stroke: parseWireStroke(value.stroke) };
  if (value.k === "pop" && exactKeys(value, ["k"])) return { k: "pop" };
  if (value.k === "reset" && exactKeys(value, ["k", "strokes"]) && Array.isArray(value.strokes) && value.strokes.length <= LIMITS.strokesPerDocument)
    return { k: "reset", strokes: value.strokes.map(parseWireStroke) };
  throw new Error("Invalid operation.");
}
export function parseOpMessage(value: unknown): OpMessage {
  if (!isObject(value) || !exactKeys(value, ["t", "doc", "rev", "op", "redo"]) || value.t !== "op" || !isDocId(value.doc) ||
    !Number.isSafeInteger(value.rev) || (value.rev as number) < 1 || !Number.isSafeInteger(value.redo) || (value.redo as number) < 0)
    throw new Error("Invalid operation message.");
  return { t: "op", doc: value.doc, rev: value.rev as number, op: parseOp(value.op), redo: value.redo as number };
}
/** Applies one committed operation to a mirrored stroke list (server and iPad). */
export function applyOp(strokes: readonly WireStroke[], op: DocOp): WireStroke[] {
  switch (op.k) {
    case "push": return [...strokes, op.stroke];
    case "pop": return strokes.slice(0, -1);
    case "reset": return [...op.strokes];
  }
}
