/** Backend half of the iPad companion: owns the opt-in LAN server, pairing and the
 * relay between companion devices and the desktop window (via the plugin's own
 * call/notification bridge). Drawing content stays owned by the desktop window. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import qrcode from "qrcode-generator";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { Pairing, type DeviceRecord } from "./pairing.ts";
import { isDocId, isId, parseDocSnapshot, parseOpMessage } from "./protocol.ts";
import { CompanionServer, type CompanionAssets } from "./server.ts";

export { DEFAULT_PORT } from "./constants.ts";
import { DEFAULT_PORT } from "./constants.ts";
/** A window that has not published or reported liveness for this long no longer owns the sheet. */
export const OWNER_TIMEOUT_MS = 150_000; // well above background-timer throttling
export interface CompanionConfig { enabled: boolean; port: number }
export interface CompanionAddress { address: string; interface: string; preferred: boolean }
export interface CompanionStatus {
  running: boolean;
  port: number;
  error?: string;
  addresses: CompanionAddress[];
  devices: { id: string; name: string; lastSeen: number; connected: boolean }[];
  pairingExpires?: number;
}
export interface PairingInfo { expires: number; links: { address: string; url: string; qr: string[] }[] }

export function parsePort(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1024 || (value as number) > 65535) throw new Error("Use a port from 1024 to 65535.");
  return value as number;
}
export function parseConfig(value: unknown): CompanionConfig {
  if (value === undefined) return { enabled: false, port: DEFAULT_PORT };
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { version?: unknown }).version !== 1)
    throw new Error("Unsupported companion settings file.");
  const input = value as Record<string, unknown>;
  return { enabled: input.enabled === true, port: parsePort(input.port) };
}
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|vbox|utun|tailscale|ZeroTier|Loopback/i;
/** LAN IPv4 addresses, most likely Wi-Fi/Ethernet first. Link-local/loopback excluded. */
export function lanAddresses(interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): CompanionAddress[] {
  const found: (CompanionAddress & { rank: number })[] = [];
  for (const [name, entries] of Object.entries(interfaces)) for (const entry of entries ?? []) {
    if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
    const rank = (PRIVATE.test(entry.address) ? 0 : 2) + (VIRTUAL.test(name) ? 1 : 0);
    found.push({ address: entry.address, interface: name, preferred: false, rank });
  }
  found.sort((a, b) => a.rank - b.rank || a.address.localeCompare(b.address, "en", { numeric: true }));
  return found.map(({ rank, ...rest }, index) => ({ ...rest, preferred: index === 0 && rank === 0 }));
}
/** QR module rows ("1" dark, "0" light). Rendered by the desktop with DOM APIs only. */
export function qrRows(text: string): string[] {
  const code = qrcode(0, "M");
  code.addData(text, "Byte"); code.make();
  const size = code.getModuleCount(), rows: string[] = [];
  for (let row = 0; row < size; row++) {
    let line = "";
    for (let col = 0; col < size; col++) line += code.isDark(row, col) ? "1" : "0";
    rows.push(line);
  }
  return rows;
}
function atomicWrite(directory: string, file: string, value: unknown): void {
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function readJSON(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export function loadAssets(directory: string): CompanionAssets {
  const read = (name: string) => fs.readFileSync(path.join(directory, "companion", name), "utf8");
  try { return { html: read("index.html"), js: read("app.js"), css: read("app.css") }; }
  catch { throw new Error("The iPad companion page is missing from this Drawing Pad build. Rebuild the plugin."); }
}

export interface CompanionBackendOptions { host?: string; interfaces?: () => ReturnType<typeof os.networkInterfaces>; now?: () => number }
export function activateCompanion(ctx: PluginBackendContext, options: CompanionBackendOptions = {}): () => Promise<void> {
  const configFile = path.join(ctx.dataDirectory, "companion.json");
  const devicesFile = path.join(ctx.dataDirectory, "companion-devices.json");
  const now = options.now ?? Date.now;
  let config: CompanionConfig = parseConfig(readJSON(configFile));
  const pairing = new Pairing({
    load: () => readJSON(devicesFile),
    save: (devices: DeviceRecord[]) => atomicWrite(ctx.dataDirectory, devicesFile, { version: 1, devices }),
  }, now);
  let server: CompanionServer | undefined, error: string | undefined, disposed = false;
  /** Only the desktop window that most recently opened Draw owns the companion sheet. */
  let activeHost: string | undefined;
  const emit = (topic: string, data?: unknown) => { if (!disposed && !ctx.signal.aborted) ctx.events.emit(topic, data); };
  const status = (): CompanionStatus => {
    const connected = new Set(server?.connected().map(device => device.id));
    const expires = server?.listening ? pairing.codeExpires() : undefined;
    return {
      running: !!server?.listening, port: server?.listening ? server.address : config.port, ...(error ? { error } : {}),
      addresses: lanAddresses(options.interfaces?.()),
      devices: pairing.list().map(device => ({ id: device.id, name: device.name, lastSeen: device.lastSeen, connected: connected.has(device.id) })),
      ...(expires ? { pairingExpires: expires } : {}),
    };
  };
  const changed = () => emit("companion-status", status());
  /** The owning window reports liveness every 15 s; a closed/reloaded one stops. */
  let lastAlive = 0, ownerClaimedAt = 0;
  const ownerAlive = () => activeHost !== undefined && now() - lastAlive <= OWNER_TIMEOUT_MS;
  const watchdog = setInterval(() => {
    // Ask windows to republish: a live owner whose pings were delayed takes the sheet back.
    if (activeHost !== undefined && !ownerAlive()) { activeHost = undefined; server?.setState(null, false); emit("companion-need-state"); }
  }, OWNER_TIMEOUT_MS / 3);
  watchdog.unref?.();
  const saveConfig = (next: CompanionConfig) => { atomicWrite(ctx.dataDirectory, configFile, { version: 1, ...next }); config = next; };
  const assertActive = () => { if (disposed || ctx.signal.aborted) throw new Error("Drawing Pad is disabled."); };

  async function start(port = config.port): Promise<CompanionStatus> {
    assertActive();
    if (server?.listening && server.address === port) return status();
    await stop(false);
    const instance = new CompanionServer(loadAssets(ctx.directory), pairing, {
      intent: (intent, device) => {
        // Ownership and liveness are decided here, in one order with claims, so an
        // intent can never land in a window that no longer owns (or no longer has) it.
        if (!ownerAlive() || !intent.doc.startsWith(`${activeHost}.`)) {
          if (intent.t === "stroke") instance.reject(intent.stroke.id, "This drawing is no longer open on the computer.");
          instance.setState(ownerAlive() ? instance.currentState() : null, ownerAlive());
          return;
        }
        emit("companion-intent", { intent, device: device.id });
      },
      live: (message, device) => emit("companion-live", { message, device: device.id }),
      changed: () => { if (server === instance) { try { pairing.flush(); } catch { /* best effort */ } changed(); } },
      needState: () => emit("companion-need-state"),
    }, now);
    try {
      await instance.start(port, options.host ?? "0.0.0.0");
    } catch (failure) {
      const code = (failure as NodeJS.ErrnoException).code;
      error = code === "EADDRINUSE" ? `Port ${port} is already in use. Choose another port.`
        : code === "EACCES" ? `Permission denied for port ${port}. Choose another port.`
        : `Could not start the companion server: ${failure instanceof Error ? failure.message : String(failure)}`;
      changed();
      throw new Error(error);
    }
    if (disposed || ctx.signal.aborted) { await instance.stop(); assertActive(); }
    server = instance; error = undefined;
    // Devices that connect before the window republishes see "waiting for computer".
    emit("companion-need-state");
    changed();
    return status();
  }
  async function stop(notify = true): Promise<void> {
    const current = server;
    server = undefined;
    pairing.cancelCode();
    if (current) { try { pairing.flush(); } catch { /* best effort */ } await current.stop(); }
    if (notify) changed();
  }
  const objectInput = (input: unknown): Record<string, unknown> => {
    if (input === undefined || input === null) return {};
    if (typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an object.");
    return input as Record<string, unknown>;
  };
  const unregister = [
    ctx.handle("companion-status", () => { assertActive(); return status(); }),
    ctx.handle("companion-start", async input => {
      const { port } = objectInput(input);
      const next = { enabled: true, port: port === undefined ? config.port : parsePort(port) };
      const result = await start(next.port);
      saveConfig(next);
      return result;
    }),
    ctx.handle("companion-stop", async () => {
      assertActive();
      saveConfig({ ...config, enabled: false });
      await stop();
      return status();
    }),
    ctx.handle("companion-pair", (): PairingInfo => {
      assertActive();
      if (!server?.listening) throw new Error("Start the iPad companion first.");
      const { code, expires } = pairing.createCode();
      const port = server.address;
      changed();
      return { expires, links: lanAddresses(options.interfaces?.()).map(({ address }) => {
        const url = `http://${address}:${port}/#pair=${code}`;
        return { address, url, qr: qrRows(url) };
      }) };
    }),
    ctx.handle("companion-revoke", input => {
      assertActive();
      const { deviceId } = objectInput(input);
      if (deviceId !== undefined && (typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(deviceId))) throw new Error("Invalid device.");
      const removed = pairing.revoke(deviceId as string | undefined);
      if (deviceId === undefined) pairing.cancelCode();
      server?.disconnect(removed);
      changed();
      return status();
    }),
    ctx.handle("companion-publish", input => {
      assertActive();
      const value = objectInput(input);
      if (!isId(value.host)) throw new Error("Invalid host.");
      if (value.release === true) {
        // The owning window closed or the plugin was disabled in it.
        if (activeHost === value.host) { activeHost = undefined; server?.setState(null, false); }
        return { ok: true };
      }
      if ("state" in value) {
        // Only an explicit claim (the user opened Draw in that window) moves ownership
        // away from a live owner.
        // The window where Draw was opened most recently owns the sheet. An explicit claim
        // beats any older claim; a plain republish only wins if it is strictly newer.
        const claimedAt = Number.isSafeInteger(value.claimedAt) ? value.claimedAt as number : 0;
        if (ownerAlive() && activeHost !== value.host &&
          !(value.claim === true ? claimedAt >= ownerClaimedAt : claimedAt > ownerClaimedAt)) return { ignored: true };
        const doc = value.state === null ? null : parseDocSnapshot(value.state);
        if (doc && !doc.id.startsWith(`${value.host}.`)) throw new Error("Snapshot does not belong to this window.");
        activeHost = value.host; lastAlive = now(); ownerClaimedAt = claimedAt;
        server?.setState(doc, true);
        return { ok: true };
      }
      // No owner yet (e.g. the backend restarted): ask the window for a full state.
      if (activeHost === undefined) return { resync: true };
      if (activeHost !== value.host) return { ignored: true };
      lastAlive = now();
      const op = parseOpMessage(value.op);
      if (!server) return { ok: true };
      return server.applyOp(op) ? { ok: true } : { resync: true };
    }),
    ctx.handle("companion-alive", input => {
      assertActive();
      const value = objectInput(input);
      if (isId(value.host) && value.host === activeHost) { lastAlive = now(); return { ok: true }; }
      return { ignored: true };
    }),
    ctx.handle("companion-reject", input => {
      assertActive();
      const value = objectInput(input);
      if (!isId(value.host) || value.host !== activeHost || !isId(value.id) || typeof value.reason !== "string" || !isDocId(value.doc))
        return { ignored: true };
      server?.reject(value.id, value.reason.slice(0, 200));
      return { ok: true };
    }),
  ];
  let starting: Promise<unknown> | undefined;
  if (config.enabled) starting = start().catch(() => { /* reported through status.error */ });
  return async () => {
    if (disposed) return;
    disposed = true;
    clearInterval(watchdog);
    for (const off of unregister) off();
    await starting;
    await stop(false);
  };
}
