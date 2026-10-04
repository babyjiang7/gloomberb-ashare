import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_READY_BYTES = 8_192;

export interface BridgeRuntimeOptions {
  pythonPath?: string;
  runtimeDir?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  log?: { info?(message: string): void; error?(message: string): void };
}

/** The interpreter created by Python's venv module on each native platform. */
export function defaultBridgePythonPath(projectRoot: string, platform = process.platform): string {
  return platform === "win32" ? join(projectRoot, ".venv", "Scripts", "python.exe") : join(projectRoot, ".venv", "bin", "python");
}

export interface BridgeRuntime {
  /** Concurrent callers share one child and one startup promise. */
  ensureStarted(): Promise<string>;
  /** Synchronous plugin hook; bounded shutdown continues in the background. */
  dispose(): void;
  closed(): Promise<void>;
}

export class BridgeRuntimeError extends Error {
  constructor(readonly code: string) {
    super(`A 股本地服务不可用（${code}）。请检查插件的 Python 环境。`);
    this.name = "BridgeRuntimeError";
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new BridgeRuntimeError("INVALID_TIMEOUT");
  return value;
}

function readyUrl(raw: unknown, childPid: number | undefined): string {
  if (!raw || typeof raw !== "object") throw new BridgeRuntimeError("INVALID_READY");
  const ready = raw as Record<string, unknown>;
  if (ready.event !== "ready" || ready.service !== "ashare-local" || ready.schemaVersion !== 1
    || ready.readOnly !== true || ready.parentStdin !== true || ready.pid !== childPid
    || typeof ready.listening !== "string") throw new BridgeRuntimeError("INVALID_READY");
  let url: URL;
  try { url = new URL(ready.listening); } catch { throw new BridgeRuntimeError("INVALID_READY"); }
  const port = Number(url.port);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new BridgeRuntimeError("INVALID_READY");
  }
  return url.origin;
}

interface OwnedChild {
  process: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  stopping: boolean;
  exited: boolean;
  cancelStart?: () => void;
}

export function createBridgeRuntime(options: BridgeRuntimeOptions = {}): BridgeRuntime {
  const pythonPath = options.pythonPath || defaultBridgePythonPath(PROJECT_ROOT);
  if (!isAbsolute(pythonPath) || (options.runtimeDir && !isAbsolute(options.runtimeDir))) {
    throw new BridgeRuntimeError("ABSOLUTE_PATH_REQUIRED");
  }
  const startupTimeoutMs = positiveDuration(options.startupTimeoutMs, 12_000);
  const shutdownTimeoutMs = positiveDuration(options.shutdownTimeoutMs, 1_000);
  let current: OwnedChild | null = null;
  let startPromise: Promise<string> | null = null;
  let lastClosed: Promise<void> = Promise.resolve();
  let disposed = false;

  function report(level: "info" | "error", message: string): void {
    try { options.log?.[level]?.(message); } catch { /* Host logging must not alter child ownership. */ }
  }

  function stop(child: OwnedChild): void {
    if (child.stopping || child.exited) return;
    child.stopping = true;
    child.cancelStart?.();
    child.process.stdin.end();
    const terminate = setTimeout(() => {
      if (child.exited) return;
      child.process.kill("SIGTERM");
      const force = setTimeout(() => {
        if (!child.exited) child.process.kill("SIGKILL");
      }, shutdownTimeoutMs);
      force.unref();
      void child.closed.then(() => clearTimeout(force));
    }, shutdownTimeoutMs);
    terminate.unref();
    void child.closed.then(() => clearTimeout(terminate));
  }

  function start(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const args = ["-u", "-m", "bridge.server", "--port", "0", "--parent-stdin"];
      if (options.runtimeDir) args.push("--runtime-dir", options.runtimeDir);
      const process = spawn(pythonPath, args, { cwd: PROJECT_ROOT, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let resolveClosed!: () => void;
      const child: OwnedChild = { process, stopping: false, exited: false,
        closed: new Promise<void>((done) => { resolveClosed = done; }) };
      current = child;
      lastClosed = Promise.all([lastClosed, child.closed]).then(() => {});
      let settled = false;
      let readySeen = false;
      let readyBuffer = "";
      let stderrBytes = 0;
      const healthAbort = new AbortController();
      const timer = setTimeout(() => fail(new BridgeRuntimeError("START_TIMEOUT")), startupTimeoutMs);
      timer.unref();

      function fail(error: BridgeRuntimeError): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        healthAbort.abort();
        // Do not copy Python stderr, file paths or request values into host logs.
        if (error.code !== "DISPOSED") report("error", `A 股本地服务启动失败：${error.code}；stderrBytes=${stderrBytes}`);
        stop(child);
        reject(error);
      }
      child.cancelStart = () => fail(new BridgeRuntimeError("DISPOSED"));

      process.stdin.on("error", () => { /* A child closing the pipe must not raise an uncaught EPIPE. */ });
      process.stderr.on("data", (chunk: Buffer) => { stderrBytes = Math.min(MAX_READY_BYTES, stderrBytes + chunk.length); });
      process.on("error", () => fail(new BridgeRuntimeError("SPAWN_FAILED")));
      process.on("exit", () => {
        child.exited = true;
        if (!settled) fail(new BridgeRuntimeError("CHILD_EXITED"));
        else if (!child.stopping && !disposed) report("error", "A 股本地服务意外退出；下次查询将重新启动。");
        if (current === child) { current = null; startPromise = null; }
      });
      process.on("close", () => { child.exited = true; resolveClosed(); });
      process.stdout.on("data", (chunk: Buffer) => {
        if (readySeen || settled) return;
        readyBuffer += chunk.toString("utf8");
        if (Buffer.byteLength(readyBuffer) > MAX_READY_BYTES) return fail(new BridgeRuntimeError("INVALID_READY"));
        const newline = readyBuffer.indexOf("\n");
        if (newline < 0) return;
        readySeen = true;
        let base: string;
        try { base = readyUrl(JSON.parse(readyBuffer.slice(0, newline)), process.pid); }
        catch { return fail(new BridgeRuntimeError("INVALID_READY")); }
        readyBuffer = "";
        void fetch(`${base}/health`, { signal: healthAbort.signal }).then(async (response) => {
          if (!response.ok || !response.body) throw new BridgeRuntimeError("HEALTH_FAILED");
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > MAX_READY_BYTES) { await reader.cancel(); throw new BridgeRuntimeError("HEALTH_FAILED"); }
            chunks.push(value);
          }
          const text = Buffer.concat(chunks).toString("utf8");
          const value = JSON.parse(text) as { ok?: unknown; data?: Record<string, unknown> };
          if (value.ok !== true || value.data?.service !== "ashare-local" || value.data.schemaVersion !== 1
            || value.data.readOnly !== true || value.data.processId !== process.pid) throw new BridgeRuntimeError("HEALTH_FAILED");
          if (settled) return;
          if (disposed || child.exited || child.stopping) return fail(new BridgeRuntimeError("DISPOSED"));
          settled = true;
          clearTimeout(timer);
          report("info", "A 股本地服务已启动。");
          resolve(base);
        }).catch(() => fail(new BridgeRuntimeError("HEALTH_FAILED")));
      });
      if (disposed) fail(new BridgeRuntimeError("DISPOSED"));
    });
  }

  return {
    ensureStarted() {
      if (disposed) return Promise.reject(new BridgeRuntimeError("DISPOSED"));
      if (startPromise) return startPromise;
      const pending = start();
      const shared = pending.catch((error: unknown) => {
        if (startPromise === shared) startPromise = null;
        throw error;
      });
      startPromise = shared;
      return shared;
    },
    dispose() { disposed = true; if (current) stop(current); },
    closed() { return lastClosed; },
  };
}
