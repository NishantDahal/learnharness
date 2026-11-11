/** iPad / Safari drawing surface for the LearnHarness Drawing Pad companion.
 * Apple Pencil draws; once a pencil has been seen, fingers only pan/zoom (palm
 * rejection). Ink is stored in the desktop pad's world coordinates. */
import { BRUSH_SIZES, paintStroke, visibleStrokes, type Point, type Stroke } from "../../strokes.ts";
import { clampScale, companionCamera, fitScale, screenToWorld, zoomPan, type Camera } from "../camera.ts";
import { LIMITS, toWire, type DocSnapshot } from "../protocol.ts";
import { CompanionConnection, type ConnectionState, type SocketLike } from "./connection.ts";
import { CompanionDocument } from "./document.ts";

type Theme = "light" | "dark";
type Tool = "pen" | "eraser";
const PREFS = "learnharness-drawing-companion-prefs";
const SIZE_LABELS = ["Fine", "Medium", "Bold", "Marker"];
interface Prefs { tool: Tool; size: number; theme: "auto" | Theme; penSeen: boolean }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
function loadPrefs(): Prefs {
  const fallback: Prefs = { tool: "pen", size: 1, theme: "auto", penSeen: false };
  try {
    const value = JSON.parse(localStorage.getItem(PREFS) ?? "{}") as Partial<Prefs>;
    return { tool: value.tool === "eraser" ? "eraser" : "pen", size: (BRUSH_SIZES as readonly number[]).includes(value.size ?? 1) ? value.size! : 1,
      theme: value.theme === "light" || value.theme === "dark" ? value.theme : "auto", penSeen: value.penSeen === true };
  } catch { return fallback; }
}
const randomId = () => {
  const bytes = new Uint8Array(12); crypto.getRandomValues(bytes);
  return "i" + [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
};

export function start(): void {
  const prefs = loadPrefs();
  const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* private mode */ } };
  const surface = $<HTMLDivElement>("surface");
  const background = $<HTMLImageElement>("reference");
  const inkCanvas = $<HTMLCanvasElement>("ink");
  const activeCanvas = $<HTMLCanvasElement>("active");
  const statusDot = $<HTMLSpanElement>("status-dot");
  const statusText = $<HTMLSpanElement>("status-text");
  const message = $<HTMLDivElement>("message");
  const messageText = $<HTMLParagraphElement>("message-text");
  const messageAction = $<HTMLButtonElement>("message-action");
  const sheetLabel = $<HTMLSpanElement>("sheet-label");
  const toast = $<HTMLDivElement>("toast");
  const confirm = $<HTMLDialogElement>("confirm-clear");
  const buttons = {
    pen: $<HTMLButtonElement>("tool-pen"), eraser: $<HTMLButtonElement>("tool-eraser"),
    undo: $<HTMLButtonElement>("undo"), redo: $<HTMLButtonElement>("redo"), clear: $<HTMLButtonElement>("clear"),
    theme: $<HTMLButtonElement>("theme"), fit: $<HTMLButtonElement>("fit"), finger: $<HTMLButtonElement>("finger"),
  };
  const sizeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-size]")];

  const model = new CompanionDocument();
  let connection: CompanionConnection;
  let connectionState: ConnectionState = "connecting", connectionDetail = "";
  let pan = { x: 0, y: 0 }, scale: number | undefined;
  let view = { width: 1, height: 1, dpr: 1 };

  // ---- pairing code: take it from the URL fragment, then remove it from history
  let pairCode: string | undefined;
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("pair")) { pairCode = hash.get("pair") ?? undefined; history.replaceState(null, "", location.pathname); }

  // ---- theme & rendering --------------------------------------------------
  const theme = (): Theme => prefs.theme === "auto" ? model.doc?.mode ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : prefs.theme;
  const ink = () => theme() === "light" ? "#000000" : "#ffffff";
  const camera = (): Camera => {
    const doc = model.doc;
    const s = scale ?? fitScale(view.width, doc?.width ?? 0);
    return companionCamera(view.width, view.height, doc?.width ?? 0, doc?.height ?? 0, pan, s);
  };
  function sizeCanvases(): void {
    const rect = surface.getBoundingClientRect();
    view = { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr: Math.min(window.devicePixelRatio || 1, 3) };
    for (const canvas of [inkCanvas, activeCanvas]) {
      const width = Math.round(view.width * view.dpr), height = Math.round(view.height * view.dpr);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    }
  }
  function prepare(context: CanvasRenderingContext2D, clear = true): void {
    const cam = camera();
    context.resetTransform();
    if (clear) context.clearRect(0, 0, context.canvas.width, context.canvas.height);
    context.setTransform(view.dpr * cam.scale, 0, 0, view.dpr * cam.scale, view.dpr * cam.x, view.dpr * cam.y);
  }
  let frame: number | undefined;
  const requestRender = () => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; render(); }); };
  function render(): void {
    const doc = model.doc, current = theme(), cam = camera();
    document.documentElement.dataset.theme = current;
    surface.style.backgroundColor = doc && doc.mode === current ? doc.backgroundColor : "";
    background.hidden = !doc?.background;
    if (doc?.background) {
      if (background.getAttribute("src") !== doc.background) background.src = doc.background;
      background.style.width = `${doc.width}px`; background.style.height = `${doc.height}px`;
      background.style.transform = `translate(${cam.x - doc.width * cam.scale / 2}px, ${cam.y - doc.height * cam.scale / 2}px) scale(${cam.scale})`;
      // The reference was rasterized in the desktop's theme; invert it to match ours.
      background.classList.toggle("inverted", doc.mode !== current);
    }
    const context = inkCanvas.getContext("2d")!;
    prepare(context);
    const history = model.displayStrokes();
    if (active?.stroke.tool === "eraser") history.push(active.stroke);
    for (const stroke of visibleStrokes(history)) paintStroke(context, stroke, ink());
    renderActive();
    renderChrome();
  }
  function renderActive(): void {
    const context = activeCanvas.getContext("2d")!;
    prepare(context);
    // The stroke in progress, plus Safari's predicted pencil samples so the ink keeps
    // up with the pencil tip. Predictions are drawn only, never stored or sent.
    if (active?.stroke.tool === "pen")
      paintStroke(context, { ...active.stroke, points: [...active.stroke.points, ...active.predicted] }, ink(), false);
  }
  let activeFrame: number | undefined;
  const requestActive = () => { if (activeFrame === undefined) activeFrame = requestAnimationFrame(() => { activeFrame = undefined; renderActive(); }); };
  function renderChrome(): void {
    const doc = model.doc, online = connectionState === "online", hasDoc = !!doc && online;
    buttons.pen.setAttribute("aria-pressed", String(prefs.tool === "pen"));
    buttons.eraser.setAttribute("aria-pressed", String(prefs.tool === "eraser"));
    sizeButtons.forEach(button => button.setAttribute("aria-pressed", String(Number(button.dataset.size) === prefs.size)));
    buttons.undo.disabled = !hasDoc || !model.canUndo;
    buttons.redo.disabled = !hasDoc || model.redo === 0;
    buttons.clear.disabled = !hasDoc || (!model.canUndo && model.redo === 0);
    buttons.theme.setAttribute("aria-label", `Ink: ${theme() === "light" ? "black on light" : "white on dark"} (${prefs.theme === "auto" ? "matches computer" : "manual"})`);
    buttons.theme.dataset.mode = prefs.theme;
    buttons.finger.setAttribute("aria-pressed", String(!prefs.penSeen));
    const pending = model.pending.length;
    const [dot, text] = connectionState === "online"
      ? doc ? ["live", pending ? `Syncing ${pending}…` : "Live"] : ["waiting", "Waiting"]
      : connectionState === "connecting" ? ["connecting", "Connecting…"]
      : connectionState === "denied" ? ["error", "Not paired"]
      : ["offline", pending ? `Offline · ${pending} queued` : "Offline"];
    statusDot.dataset.state = dot!; statusText.textContent = text!;
    sheetLabel.textContent = doc ? `${doc.label}${doc.kind === "practice" ? " · practice" : ""}` : "";
    // Full-screen messages only when there is nothing to draw on.
    let note = "", action = "";
    if (connectionState === "denied") { note = connectionDetail || "This iPad is not paired."; action = "Try again"; }
    else if (!model.known && connectionState !== "online") note = connectionState === "connecting" ? "Connecting to LearnHarness…" : `Can't reach LearnHarness. ${connectionDetail}`;
    else if (model.known && !doc) note = model.host ? "Open Draw in LearnHarness on your computer to start drawing here."
      : "Waiting for LearnHarness. Open a lesson and choose Draw on your computer.";
    message.hidden = !note; messageText.textContent = note;
    messageAction.hidden = !action; messageAction.textContent = action;
  }
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function notify(text: string): void {
    toast.textContent = text; toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
  }

  // ---- connection ---------------------------------------------------------
  function onState(doc: DocSnapshot | null, host: boolean): void {
    const { docChanged, resend } = model.applyState(doc, host);
    if (docChanged) { pan = { x: 0, y: 0 }; scale = undefined; cancelActive(); }
    const dropped = model.takeDropped();
    if (dropped) notify(`${dropped} stroke${dropped === 1 ? "" : "s"} not added: the drawing changed on your computer.`);
    for (const wire of resend) connection.send({ t: "stroke", doc: doc!.id, stroke: wire });
    requestRender();
  }
  connection = new CompanionConnection({
    url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
    storage: localStorage, createSocket: url => new WebSocket(url) as unknown as SocketLike,
    pairCode, name: /iPad|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1 ? "iPad" : "Tablet",
  }, {
    state: onState,
    op(op) {
      const result = model.applyOp(op);
      if (result === "resync") connection.send({ t: "sync" });
      requestRender();
    },
    reject(id, reason) { if (model.reject(id)) { notify(reason); requestRender(); } },
    status(state, detail) {
      connectionState = state; connectionDetail = detail ?? "";
      if (state !== "online") cancelLive();
      requestRender();
    },
  });

  // ---- drawing input --------------------------------------------------------
  interface Active { pointerId: number; pointerType: string; stroke: Stroke; sid: string; doc: string; sent: number; last?: Point; predicted: Point[] }
  let active: Active | undefined;
  const touches = new Map<number, { x: number; y: number }>();
  let gesture: { pan: { x: number; y: number }; scale: number; distance: number; cx: number; cy: number } | undefined;

  const pressureOf = (event: PointerEvent, previous?: Point): number => {
    const raw = event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5;
    // Light smoothing removes pressure flicker without lagging the line itself.
    return previous ? Math.round((previous.pressure * 0.35 + raw * 0.65) * 1000) / 1000 : raw;
  };
  const worldPoint = (event: PointerEvent, previous?: Point): Point => {
    const rect = surface.getBoundingClientRect();
    const point = screenToWorld(camera(), event.clientX - rect.left, event.clientY - rect.top);
    return { x: point.x, y: point.y, pressure: pressureOf(event, previous) };
  };
  function begin(event: PointerEvent): void {
    const doc = model.doc;
    if (!doc) return;
    const stroke: Stroke = { tool: prefs.tool, points: [], ...(prefs.size === 1 ? {} : { size: prefs.size }) };
    active = { pointerId: event.pointerId, pointerType: event.pointerType, stroke, sid: randomId(), doc: doc.id, sent: 0, predicted: [] };
    extend(event);
    surface.setPointerCapture(event.pointerId);
  }
  function extend(event: PointerEvent): void {
    if (!active) return;
    const samples = event.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length ? samples : [event]) {
      const point = worldPoint(sample, active.last);
      const last = active.last;
      // Drop sub-pixel jitter; keep the first point (dots).
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.35 / camera().scale) continue;
      active.stroke.points.push(point); active.last = point;
      if (active.stroke.points.length >= LIMITS.pointsPerStroke - 1) { finish(true); return; }
    }
    active.predicted = [];
    if (event.type === "pointermove") for (const sample of (event.getPredictedEvents?.() ?? []).slice(0, 3)) {
      const point = worldPoint(sample, active.predicted.at(-1) ?? active.last);
      if (active.last && Math.hypot(point.x - active.last.x, point.y - active.last.y) > 40 / camera().scale) break;
      active.predicted.push(point);
    }
    if (active.stroke.tool === "eraser") requestRender(); else requestActive();
    scheduleLive();
  }
  let liveFrame: number | undefined;
  function scheduleLive(): void {
    if (liveFrame === undefined) liveFrame = requestAnimationFrame(() => { liveFrame = undefined; flushLive(); });
  }
  function flushLive(): void {
    if (!active || active.doc !== model.doc?.id || !connection.online) return;
    const points = active.stroke.points.slice(active.sent, active.sent + LIMITS.livePointsPerMessage);
    if (!points.length) return;
    const wire = toWire({ ...active.stroke, points }, active.sid);
    if (connection.send({ t: "live", doc: active.doc, sid: active.sid, tool: active.stroke.tool, size: wire.size, from: active.sent, pts: wire.pts }))
      active.sent += points.length;
    if (active.sent < active.stroke.points.length) scheduleLive();
  }
  function finish(continueStroke = false): void {
    const current = active;
    if (!current) return;
    active = undefined;
    if (current.stroke.points.length && current.doc === model.doc?.id) {
      const wire = toWire(current.stroke, current.sid);
      model.addPending(wire);
      // If offline, the stroke stays pending and is resent after the next snapshot.
      connection.send({ t: "stroke", doc: current.doc, stroke: wire });
    } else if (current.sent) connection.send({ t: "live-end", doc: current.doc, sid: current.sid });
    if (continueStroke && current.last) {
      active = { ...current, stroke: { ...current.stroke, points: [current.last] }, sid: randomId(), sent: 0, predicted: [] };
    }
    requestRender();
  }
  function cancelActive(): void {
    if (active?.sent) connection.send({ t: "live-end", doc: active.doc, sid: active.sid });
    active = undefined;
  }
  function cancelLive(): void { if (active) active.sent = 0; }

  // Buttons inside the surface (e.g. "Try again") must keep their native taps.
  const isControl = (target: EventTarget | null) => target instanceof Element && !!target.closest("button, dialog, a");
  const penDown = () => active?.pointerType === "pen";
  surface.addEventListener("pointerdown", event => {
    if (isControl(event.target)) return;
    event.preventDefault();
    if (event.pointerType === "pen") {
      if (!prefs.penSeen) { prefs.penSeen = true; savePrefs(); renderChrome(); }
      // The pencil always wins: drop a palm/finger stroke or gesture already in progress.
      if (active?.pointerType === "touch") { cancelActive(); requestRender(); }
      touches.clear(); gesture = undefined;
    }
    if (event.pointerType === "touch") {
      // Palm rejection: while the pencil is down, touches are ignored entirely.
      if (penDown()) return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (prefs.penSeen || touches.size > 1) {
        if (active?.pointerType === "touch") { cancelActive(); requestRender(); }
        startGesture();
        surface.setPointerCapture(event.pointerId);
        return;
      }
    }
    const drawsWith = event.pointerType === "pen" || event.pointerType === "mouse" || (event.pointerType === "touch" && !prefs.penSeen);
    if (!drawsWith || active || event.button > 0 || !model.doc) return;
    begin(event);
  }, { passive: false });
  surface.addEventListener("pointermove", event => {
    if (touches.has(event.pointerId)) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (active && event.pointerId === active.pointerId) { event.preventDefault(); extend(event); return; }
    // Apple Pencil hover (no contact) and palms during a pencil stroke never move the view.
    if (touches.has(event.pointerId) && !penDown()) moveGesture();
  }, { passive: false });
  const end = (event: PointerEvent) => {
    if (active && event.pointerId === active.pointerId) {
      // Pencil lift events report pressure 0; like the desktop pad, do not add them.
      if (event.type === "pointerup" && event.pointerType !== "pen") extend(event);
      // A cancelled pencil stroke is still kept: losing handwriting is worse.
      finish();
    }
    if (touches.delete(event.pointerId) && !penDown()) startGesture();
  };
  for (const type of ["pointerup", "pointercancel"] as const) surface.addEventListener(type, end);
  surface.addEventListener("lostpointercapture", event => { if (active?.pointerId === event.pointerId) finish(); });

  function centroid(): { cx: number; cy: number; distance: number } {
    const points = [...touches.values()];
    const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length, cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const distance = points.length > 1 ? Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y) : 0;
    return { cx, cy, distance };
  }
  function startGesture(): void {
    if (!touches.size) { gesture = undefined; return; }
    const c = centroid();
    gesture = { pan: { ...pan }, scale: camera().scale, ...c };
  }
  function moveGesture(): void {
    if (!gesture || !touches.size) return;
    const c = centroid(), rect = surface.getBoundingClientRect();
    let nextScale = gesture.scale;
    if (touches.size > 1 && gesture.distance > 0 && c.distance > 0) nextScale = clampScale(gesture.scale * c.distance / gesture.distance);
    const doc = model.doc, refW = doc?.width ?? 0, refH = doc?.height ?? 0;
    const zoomed = zoomPan(view.width, view.height, refW, refH, gesture.pan, gesture.scale, nextScale, gesture.cx - rect.left, gesture.cy - rect.top);
    pan = { x: zoomed.x + c.cx - gesture.cx, y: zoomed.y + c.cy - gesture.cy };
    scale = nextScale;
    requestRender();
  }

  // Stop Safari page scrolling, pinch-zoom, callouts and text selection.
  for (const type of ["touchstart", "touchmove"] as const)
    surface.addEventListener(type, event => { if (!isControl(event.target)) event.preventDefault(); }, { passive: false });
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, event => event.preventDefault(), { passive: false });
  document.addEventListener("contextmenu", event => event.preventDefault());
  document.addEventListener("selectstart", event => event.preventDefault());
  document.addEventListener("dblclick", event => event.preventDefault(), { passive: false });

  // ---- toolbar --------------------------------------------------------------
  const edit = (t: "undo" | "redo") => { const doc = model.doc; if (doc && connection.send({ t, doc: doc.id })) navigator.vibrate?.(5); };
  buttons.pen.addEventListener("click", () => { prefs.tool = "pen"; savePrefs(); renderChrome(); });
  buttons.eraser.addEventListener("click", () => { prefs.tool = "eraser"; savePrefs(); renderChrome(); });
  sizeButtons.forEach((button, index) => {
    button.title = button.ariaLabel = `Brush: ${SIZE_LABELS[index] ?? button.dataset.size}`;
    button.addEventListener("click", () => { prefs.size = Number(button.dataset.size); savePrefs(); renderChrome(); });
  });
  buttons.undo.addEventListener("click", () => edit("undo"));
  buttons.redo.addEventListener("click", () => edit("redo"));
  buttons.clear.addEventListener("click", () => { if (typeof confirm.showModal === "function") confirm.showModal(); else if (window.confirm("Clear the whole drawing on both devices?")) clearNow(); });
  const clearNow = () => { const doc = model.doc; if (doc) connection.send({ t: "clear", doc: doc.id }); };
  confirm.addEventListener("close", () => { if (confirm.returnValue === "clear") clearNow(); });
  buttons.theme.addEventListener("click", () => {
    const order: Prefs["theme"][] = ["auto", "light", "dark"];
    prefs.theme = order[(order.indexOf(prefs.theme) + 1) % order.length]!; savePrefs(); render();
  });
  // Once Apple Pencil is used, fingers only move the view (palm rejection); this
  // switches finger drawing back on (e.g. pencil battery empty). The pencil turns it off.
  buttons.finger.addEventListener("click", () => { prefs.penSeen = !prefs.penSeen; savePrefs(); renderChrome(); });
  buttons.fit.addEventListener("click", () => { pan = { x: 0, y: 0 }; scale = undefined; requestRender(); });
  messageAction.addEventListener("click", () => connection.retry());

  // ---- lifecycle ------------------------------------------------------------
  new ResizeObserver(() => { sizeCanvases(); render(); }).observe(surface);
  window.addEventListener("orientationchange", () => { sizeCanvases(); requestRender(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { connection.wake(); void keepAwake(); } });
  window.addEventListener("online", () => connection.wake());
  window.addEventListener("pageshow", () => connection.wake());
  let wakeLock: { release(): Promise<void> } | undefined;
  async function keepAwake(): Promise<void> {
    try {
      const api = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (api && !wakeLock) { wakeLock = await api.request("screen"); (wakeLock as unknown as EventTarget).addEventListener?.("release", () => { wakeLock = undefined; }); }
    } catch { /* not supported or not allowed: the iPad may dim as usual */ }
  }
  sizeCanvases(); render(); connection.connect(); void keepAwake();
}
start();
