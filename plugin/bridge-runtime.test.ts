import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createBridgeRuntime, defaultBridgePythonPath } from "./bridge-runtime";

const pythonPath = defaultBridgePythonPath(fileURLToPath(new URL("../", import.meta.url)));
// These fault injections are executable files with POSIX shebangs. Windows
// spawn() cannot execute them directly; real Python service tests still run.
const posixFixtureTest = test.skipIf(process.platform === "win32");

test("the default bridge interpreter follows the platform's venv layout", () => {
  const root = join(tmpdir(), "ashare plugin");
  expect(defaultBridgePythonPath(root, "win32")).toBe(join(root, ".venv", "Scripts", "python.exe"));
  expect(defaultBridgePythonPath(root, "darwin")).toBe(join(root, ".venv", "bin", "python"));
  expect(defaultBridgePythonPath(root, "linux")).toBe(join(root, ".venv", "bin", "python"));
});

async function fixture(directory: string, source: string): Promise<string> {
  const path = join(directory, "fixture-python");
  await writeFile(path, `#!${pythonPath}\n${source}\n`, { mode: 0o700 });
  return path;
}

test("concurrent startup shares one dynamic healthy service, regardless of host cwd; dispose owns only it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ashare-runtime-"));
  const originalCwd = process.cwd();
  const messages: string[] = [];
  const first = createBridgeRuntime({ runtimeDir: join(directory, "first"), log: { info: (value) => { messages.push(value); } } });
  const second = createBridgeRuntime({ runtimeDir: join(directory, "second") });
  try {
    process.chdir(directory);
    const a = first.ensureStarted();
    const b = first.ensureStarted();
    expect(a).toBe(b);
    const [baseA, baseB] = await Promise.all([a, second.ensureStarted()]);
    expect(baseA).not.toBe(baseB);
    expect(messages).toHaveLength(1);
    const health = await (await fetch(`${baseA}/health`)).json() as { data: { service: string } };
    expect(health.data.service).toBe("ashare-local");
    first.dispose();
    await first.closed();
    expect((await fetch(`${baseB}/health`)).ok).toBe(true);
    await expect(first.ensureStarted()).rejects.toThrow("DISPOSED");
  } finally {
    process.chdir(originalCwd);
    first.dispose(); second.dispose();
    await Promise.all([first.closed(), second.closed()]);
    await rm(directory, { recursive: true, force: true });
  }
});

posixFixtureTest("POSIX executable fixture: startup failures redact stderr and close failed children before a retry is accounted for", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ashare-runtime-failure-"));
  const messages: string[] = [];
  const path = await fixture(directory, "import sys\nprint('private-secret-token',file=sys.stderr,flush=True)\nsys.exit(9)");
  const runtime = createBridgeRuntime({ pythonPath: path, shutdownTimeoutMs: 25, log: { error: (value) => { messages.push(value); } } });
  try {
    await expect(runtime.ensureStarted()).rejects.toThrow("CHILD_EXITED");
    await expect(runtime.ensureStarted()).rejects.toThrow("CHILD_EXITED");
    await runtime.closed();
    expect(messages.length).toBe(2);
    expect(messages.join(" ")).not.toContain("private-secret-token");
    expect(messages.join(" ")).toContain("stderrBytes=");
  } finally { runtime.dispose(); await runtime.closed(); await rm(directory, { recursive: true, force: true }); }
});

test("missing Python fails without leaving a service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ashare-runtime-missing-"));
  const missing = createBridgeRuntime({ pythonPath: join(directory, "missing-python") });
  try {
    await expect(missing.ensureStarted()).rejects.toThrow("SPAWN_FAILED");
    await missing.closed();
  } finally {
    missing.dispose();
    await missing.closed();
    await rm(directory, { recursive: true, force: true });
  }
});

posixFixtureTest("POSIX executable fixture: untrusted ready handshakes fail without leaving a service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ashare-runtime-ready-"));
  const path = await fixture(directory, "import json,os,sys\nprint(json.dumps({'event':'ready','service':'ashare-local','schemaVersion':1,'readOnly':True,'parentStdin':True,'pid':os.getpid(),'listening':'http://example.com:8765'}),flush=True)\nsys.stdin.read()");
  const invalid = createBridgeRuntime({ pythonPath: path, shutdownTimeoutMs: 25 });
  try {
    await expect(invalid.ensureStarted()).rejects.toThrow("INVALID_READY");
    await invalid.closed();
  } finally { invalid.dispose(); await invalid.closed(); await rm(directory, { recursive: true, force: true }); }
});

posixFixtureTest("POSIX executable fixture: startup timeout and dispose during startup both terminate children that ignore graceful shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ashare-runtime-timeout-"));
  const path = await fixture(directory, "import signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\ntime.sleep(30)");
  const timeout = createBridgeRuntime({ pythonPath: path, startupTimeoutMs: 100, shutdownTimeoutMs: 25 });
  const disposed = createBridgeRuntime({ pythonPath: path, startupTimeoutMs: 2_000, shutdownTimeoutMs: 25 });
  try {
    await expect(timeout.ensureStarted()).rejects.toThrow("START_TIMEOUT");
    await timeout.closed();
    const pending = disposed.ensureStarted();
    disposed.dispose();
    await expect(pending).rejects.toThrow("DISPOSED");
    await disposed.closed();
  } finally { timeout.dispose(); disposed.dispose(); await Promise.all([timeout.closed(), disposed.closed()]); await rm(directory, { recursive: true, force: true }); }
});

posixFixtureTest("POSIX executable fixture: a ready endpoint cannot impersonate a different child's health identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ashare-runtime-health-"));
  const path = await fixture(directory, "import json,os\nfrom http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  raw=json.dumps({'ok':True,'data':{'service':'ashare-local','schemaVersion':1,'readOnly':True,'processId':os.getpid()+1}}).encode()\n  self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)\ns=HTTPServer(('127.0.0.1',0),H)\nprint(json.dumps({'event':'ready','service':'ashare-local','schemaVersion':1,'readOnly':True,'parentStdin':True,'pid':os.getpid(),'listening':'http://127.0.0.1:'+str(s.server_port)}),flush=True)\ns.serve_forever()");
  const runtime = createBridgeRuntime({ pythonPath: path, shutdownTimeoutMs: 25 });
  try {
    await expect(runtime.ensureStarted()).rejects.toThrow("HEALTH_FAILED");
    await runtime.closed();
  } finally { runtime.dispose(); await runtime.closed(); await rm(directory, { recursive: true, force: true }); }
});

test("an abruptly killed Bun owner leaves no listening Python child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ashare-runtime-owner-"));
  const entry = join(directory, "owner.ts");
  const moduleUrl = new URL("./bridge-runtime.ts", import.meta.url).href;
  await writeFile(entry, `import {createBridgeRuntime} from ${JSON.stringify(moduleUrl)};\nconst runtime=createBridgeRuntime({runtimeDir:${JSON.stringify(join(directory, "runtime"))}});\nconst base=await runtime.ensureStarted();\nconst health=await(await fetch(base+"/health")).json();\nconsole.log(JSON.stringify({base,pid:health.data.processId}));\nsetInterval(()=>{},1000);\n`);
  const owner = spawn(process.execPath, [entry], { stdio: ["ignore", "pipe", "pipe"] });
  let descendant: { base: string; pid: number } | null = null;
  const ownerClosed = new Promise<void>((resolve) => { owner.on("close", () => resolve()); });
  owner.stderr.resume();
  try {
    const lines = createInterface({ input: owner.stdout });
    descendant = await new Promise<{ base: string; pid: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Owner did not announce its child")), 5_000);
      lines.once("line", (line) => { clearTimeout(timer); resolve(JSON.parse(line)); });
      owner.once("exit", () => { clearTimeout(timer); reject(new Error("Owner exited before ready")); });
    });
    lines.close();
    owner.kill("SIGKILL");
    await ownerClosed;
    const deadline = Date.now() + 3_000;
    let listening = true;
    while (Date.now() < deadline) {
      try { await fetch(`${descendant.base}/health`, { signal: AbortSignal.timeout(200) }); }
      catch { listening = false; break; }
      await Bun.sleep(25);
    }
    expect(listening).toBe(false);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await ownerClosed;
    if (descendant) {
      try { process.kill(descendant.pid, 0); process.kill(descendant.pid, "SIGTERM"); } catch { /* Descendant already reaped. */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
