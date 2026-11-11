/** Pairing and device authorization for the LAN drawing companion (backend only).
 * - A pairing code is shown once as a QR/URL, expires quickly and is single use.
 * - Redeeming it issues a random device token that only the iPad keeps; the desktop
 *   stores only its SHA-256 hash, so the data file cannot be replayed as a credential.
 * - Devices are individually revocable; revocation immediately closes their sockets. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cleanName, isToken } from "./protocol.ts";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAX_DEVICES = 8;
export interface DeviceRecord { id: string; name: string; hash: string; created: number; lastSeen: number }
export interface DeviceSummary { id: string; name: string; created: number; lastSeen: number }
export interface PairingStore { load(): unknown; save(devices: DeviceRecord[]): void }

const token = (bytes = 32) => randomBytes(bytes).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex"), right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
export function parseDevices(value: unknown): DeviceRecord[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { devices?: unknown }).devices)) throw new Error("Unsupported companion device file.");
  return ((value as { devices: unknown[] }).devices).filter((device): device is DeviceRecord => {
    if (!device || typeof device !== "object") return false;
    const d = device as Record<string, unknown>;
    return typeof d.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(d.id) && typeof d.name === "string" &&
      typeof d.hash === "string" && /^[0-9a-f]{64}$/.test(d.hash) && Number.isFinite(d.created) && Number.isFinite(d.lastSeen);
  }).slice(0, MAX_DEVICES).map(d => ({ id: d.id, name: cleanName(d.name), hash: d.hash, created: d.created, lastSeen: d.lastSeen }));
}

export class Pairing {
  private devices: DeviceRecord[];
  private code: { hash: string; expires: number } | undefined;
  constructor(private readonly store: PairingStore, private readonly now: () => number = Date.now) {
    this.devices = parseDevices(store.load());
  }
  /** Creates a fresh pairing code; any previous unused code stops working. */
  createCode(ttl = PAIRING_TTL_MS): { code: string; expires: number } {
    const code = token();
    this.code = { hash: hash(code), expires: this.now() + ttl };
    return { code, expires: this.code.expires };
  }
  cancelCode(): void { this.code = undefined; }
  codeExpires(): number | undefined {
    if (this.code && this.code.expires <= this.now()) this.code = undefined;
    return this.code?.expires;
  }
  /** Consumes a valid code and returns the new device and its one-time-revealed token. */
  redeem(code: unknown, name: string): { device: DeviceSummary; token: string } | undefined {
    if (!isToken(code) || !this.code || this.code.expires <= this.now() || !sameHash(hash(code), this.code.hash)) return undefined;
    this.code = undefined;
    const secret = token(), time = this.now();
    const record: DeviceRecord = { id: token(12), name: cleanName(name), hash: hash(secret), created: time, lastSeen: time };
    // Keep the newest devices if the cap is reached; older ones must pair again.
    this.devices = [...this.devices, record].slice(-MAX_DEVICES);
    this.store.save(this.devices);
    return { device: summary(record), token: secret };
  }
  authenticate(secret: unknown): DeviceSummary | undefined {
    if (!isToken(secret)) return undefined;
    const digest = hash(secret);
    const record = this.devices.find(device => sameHash(digest, device.hash));
    if (!record) return undefined;
    record.lastSeen = this.now();
    return summary(record);
  }
  /** Persist last-seen times opportunistically (not on every reconnect). */
  flush(): void { this.store.save(this.devices); }
  list(): DeviceSummary[] { return this.devices.map(summary); }
  has(id: string): boolean { return this.devices.some(device => device.id === id); }
  revoke(id?: string): string[] {
    const removed = this.devices.filter(device => id === undefined || device.id === id).map(device => device.id);
    if (!removed.length) return [];
    this.devices = this.devices.filter(device => !removed.includes(device.id));
    this.store.save(this.devices);
    return removed;
  }
}
const summary = (record: DeviceRecord): DeviceSummary => ({ id: record.id, name: record.name, created: record.created, lastSeen: record.lastSeen });

/** Sliding-window limiter for failed authentication attempts per remote address. */
export class AttemptLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly limit = 10, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}
  blocked(address: string): boolean { return this.recent(address).length >= this.limit; }
  fail(address: string): void {
    const recent = this.recent(address); recent.push(this.now()); this.failures.set(address, recent);
    if (this.failures.size > 1000) this.failures.delete(this.failures.keys().next().value!);
  }
  private recent(address: string): number[] {
    const cutoff = this.now() - this.windowMs;
    return (this.failures.get(address) ?? []).filter(time => time > cutoff);
  }
}
