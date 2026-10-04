import { expect, test } from "bun:test";
import { BridgeClient, BridgeError, parseOffsetTimestamp, receiptTimestamp } from "./client";

const receivedAt = "2026-10-05T02:19:30+08:00";
const meta = { receivedAt, mode: "cninfo_shsz_search" };
const data = { candidates: [] };

test("receipt times require a real date and an explicit timezone", () => {
  expect(parseOffsetTimestamp(receivedAt)).toBe(Date.parse(receivedAt));
  expect(receiptTimestamp({ ...meta, receivedAt: Date.parse(receivedAt) })).toBe(Date.parse(receivedAt));
  for (const value of ["2026-10-05T02:19:30", "2026-02-30T02:19:30+08:00", "2026-10-05T25:00:00Z", "2026-10-05T02:19:30+24:00", "2026-10-05"]) {
    expect(() => parseOffsetTimestamp(value)).toThrow();
  }
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    expect(() => receiptTimestamp({ ...meta, receivedAt: value })).toThrow();
  }
});

test("requests use the owned dynamic loopback endpoint without credentials", async () => {
  const calls: Array<{ url: string; credentials: RequestCredentials | undefined }> = [];
  const client = new BridgeClient(async (url, options) => {
    calls.push({ url, credentials: options?.credentials });
    return Response.json({ ok: true, data, meta });
  }, { baseUrl: async () => "http://127.0.0.1:43123" });
  expect(await client.request("/v1/research-symbols", { q: "工业富联", limit: "10" })).toEqual({ data, meta });
  expect(calls).toEqual([{ url: "http://127.0.0.1:43123/v1/research-symbols?q=%E5%B7%A5%E4%B8%9A%E5%AF%8C%E8%81%94&limit=10", credentials: "omit" }]);
  client.setBaseUrl(() => "http://127.0.0.1:43124");
  await client.request("/v1/research-identity", { symbol: "601138.SH" });
  expect(calls[1]?.url).toBe("http://127.0.0.1:43124/v1/research-identity?symbol=601138.SH");
});

test("remote or decorated endpoints fail before making an HTTP request", async () => {
  let calls = 0;
  const client = new BridgeClient(async () => { calls++; return Response.json({ ok: true, data, meta }); });
  for (const base of ["https://127.0.0.1:43123", "http://localhost:43123", "http://example.com:43123", "http://user@127.0.0.1:43123", "http://127.0.0.1", "http://127.0.0.1:43123/private", "http://127.0.0.1:43123/?token=value", "http://127.0.0.1:43123/#fragment"]) {
    client.setBaseUrl(() => base);
    await expect(client.request("/v1/research-symbols", { q: "GYFL" })).rejects.toThrow("owned local bridge");
  }
  expect(calls).toBe(0);
});

test("retired market, financial and PDF routes fail before either transport is called", async () => {
  let calls = 0;
  const client = new BridgeClient(undefined, { transport: async () => { calls++; return { data, meta }; } });
  for (const path of ["/health", "/v1/symbols", "/v1/quotes", "/v1/history", "/v1/financials", "/v1/announcements", "/v1/cash-flow", "/v1/profit", "/v1/research-company", "/v1/research-symbols?force=1", "http://example.com/v1/research-symbols"]) {
    await expect(client.request(path, {})).rejects.toBeInstanceOf(BridgeError);
  }
  await expect(client.request("/v1/research-symbols", { limit: 10 } as unknown as Record<string, string>)).rejects.toThrow("accepted local bridge");
  expect(calls).toBe(0);
});

test("native RPC retains the request, receipt and cancellation boundaries", async () => {
  const calls: unknown[] = [];
  const controller = new AbortController();
  const client = new BridgeClient(async () => { throw new Error("The renderer must use native transport"); }, {
    transport: async (path, params, signal) => { calls.push({ path, params, signal }); return { data, meta }; },
  });
  expect(await client.request("/v1/research-symbols", { q: "GYFL" }, controller.signal)).toEqual({ data, meta });
  expect(calls).toEqual([{ path: "/v1/research-symbols", params: { q: "GYFL" }, signal: controller.signal }]);
  controller.abort();
  await expect(client.request("/v1/research-identity", { symbol: "601138.SH" }, controller.signal)).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

test("a cancelled native RPC response is discarded even when the RPC itself cannot stop", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const client = new BridgeClient(undefined, { transport: async () => { await pending; return { data, meta }; } });
  const request = client.request("/v1/research-symbols", { q: "GYFL" }, controller.signal);
  controller.abort(); release();
  await expect(request).rejects.toThrow();
});

test("a cancelled endpoint lookup does not start an HTTP request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = new BridgeClient(async () => { calls++; return Response.json({ ok: true, data, meta }); }, {
    baseUrl: async () => { controller.abort(); return "http://127.0.0.1:43123"; },
  });
  await expect(client.request("/v1/research-symbols", { q: "GYFL" }, controller.signal)).rejects.toThrow();
  expect(calls).toBe(0);
});

test("source failures and unexpected HTTP status remain explicit", async () => {
  const unavailable = new BridgeClient(async () => Response.json({ ok: false, error: { code: "source_unavailable", message: "Current issuer lookup failed" } }, { status: 502 }));
  await expect(unavailable.request("/v1/research-identity", { symbol: "601138.SH" })).rejects.toThrow("Current issuer lookup failed");
  const unexpected = new BridgeClient(async () => Response.json({ ok: true, data, meta }, { status: 503 }));
  await expect(unexpected.request("/v1/research-symbols", { q: "GYFL" })).rejects.toThrow("HTTP 503");
});

test("invalid HTTP and RPC receipts are rejected instead of inventing a fetch time", async () => {
  const invalid = { ...meta, receivedAt: "2026-10-05" };
  const http = new BridgeClient(async () => Response.json({ ok: true, data, meta: invalid }));
  const rpc = new BridgeClient(undefined, { transport: async () => ({ data, meta: invalid }) });
  for (const client of [http, rpc]) await expect(client.request("/v1/research-symbols", { q: "GYFL" })).rejects.toThrow("explicit offset");
  const malformed = new BridgeClient(async () => Response.json({ ok: true, data, meta: null }));
  await expect(malformed.request("/v1/research-symbols", { q: "GYFL" })).rejects.toThrow("bridge metadata must be an object");
});
