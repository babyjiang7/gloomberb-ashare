import { httpFetch } from "gloomberb/utils";

export const BRIDGE_BASE_URL = "http://127.0.0.1:8765";
export interface BridgeMeta { receivedAt: string | number; mode: string; [key: string]: unknown }
export interface BridgeResult<T> { data: T; meta: BridgeMeta }
export interface BridgeClientOptions {
  baseUrl?: () => string | Promise<string>;
  transport?: (path: string, params: Record<string, string>, signal?: AbortSignal) => Promise<BridgeResult<unknown>>;
}
const BRIDGE_PATHS = new Set(["/v1/research-symbols", "/v1/research-identity"]);

export class BridgeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "BridgeError"; }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("INVALID_RESPONSE", `${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BridgeError("INVALID_RESPONSE", `${label} is missing`);
  return value;
}
export function parseOffsetTimestamp(value: unknown, label = "timestamp"): number {
  const raw = string(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(raw);
  if (!match) {
    throw new BridgeError("INVALID_TIMESTAMP", `${label} requires an explicit offset`);
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const wall = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  if (year! < 1900 || wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month! - 1
    || wall.getUTCDate() !== day || wall.getUTCHours() !== hour || wall.getUTCMinutes() !== minute
    || wall.getUTCSeconds() !== second || Number(match[8] ?? 0) > 23 || Number(match[9] ?? 0) > 59) {
    throw new BridgeError("INVALID_TIMESTAMP", `${label} is not a valid calendar timestamp`);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new BridgeError("INVALID_TIMESTAMP", `${label} is invalid`);
  return parsed;
}
export function receiptTimestamp(meta: BridgeMeta): number {
  const parsed = typeof meta.receivedAt === "number" ? meta.receivedAt : parseOffsetTimestamp(meta.receivedAt, "receivedAt");
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new BridgeError("INVALID_TIMESTAMP", "receivedAt is invalid");
  return parsed;
}

export class BridgeClient {
  constructor(private readonly fetcher: typeof httpFetch = httpFetch, private readonly options: BridgeClientOptions = {}) {}

  setBaseUrl(resolve: () => string | Promise<string>): void { this.options.baseUrl = resolve; }

  async request(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<BridgeResult<unknown>> {
    if (!BRIDGE_PATHS.has(path) || Object.values(params).some((value) => typeof value !== "string")) {
      throw new BridgeError("INVALID_REQUEST", "Only accepted local bridge operations are supported");
    }
    signal?.throwIfAborted();
    if (this.options.transport) {
      const result = await this.options.transport(path, params, signal);
      signal?.throwIfAborted();
      const body = object(result, "bridge result");
      const rawMeta = object(body.meta, "bridge metadata");
      const meta = { ...rawMeta, receivedAt: rawMeta.receivedAt as string | number, mode: string(rawMeta.mode, "mode") };
      receiptTimestamp(meta);
      return { data: body.data, meta };
    }
    const base = new URL(await (this.options.baseUrl?.() ?? BRIDGE_BASE_URL));
    if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password
      || base.pathname !== "/" || base.search || base.hash || !base.port) {
      throw new BridgeError("INVALID_REQUEST", "Only the owned local bridge is supported");
    }
    signal?.throwIfAborted();
    const url = new URL(path, base);
    url.search = new URLSearchParams(params).toString();
    const timeout = AbortSignal.timeout(12_000);
    const response = await this.fetcher(url.href, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, credentials: "omit" });
    const body = object(await response.json(), "bridge response");
    if (body.ok !== true) {
      const error = object(body.error, "bridge error");
      throw new BridgeError(string(error.code, "error code"), string(error.message, "error message"));
    }
    if (!response.ok) throw new BridgeError("HTTP_ERROR", `Local bridge returned HTTP ${response.status}`);
    const rawMeta = object(body.meta, "bridge metadata");
    const meta = { ...rawMeta, receivedAt: rawMeta.receivedAt as string | number, mode: string(rawMeta.mode, "mode") };
    receiptTimestamp(meta);
    return { data: body.data, meta };
  }

}

export const bridgeClient = new BridgeClient();
