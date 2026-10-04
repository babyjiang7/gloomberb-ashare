import { expect, test } from "bun:test";
import type { GloomPluginContext } from "gloomberb/types/plugin";
import type { TickerRecord } from "gloomberb/types/ticker";
import type { InstrumentSearchResult } from "gloomberb/types/instrument";
import type { Quote, TickerFinancials } from "gloomberb/types/financials";
import { createNativeNameLifecycle, enableNativeNameColumns, formatNativeName, NATIVE_NAME_PROVENANCE_KEY, parseNativeNameProvenance,
  syncNativeNames, type NativeNameProvenance, type NativeNameProvenanceV1, type NativeNameProvenanceV2, withNativeNameColumn } from "./native-list-names";
import { parseResearchIdentity, type LoadResearchIdentity } from "./research-identity";
import { waitForNativeNameRetry } from "./native-name-retry";

const time = "2026-10-04T04:00:00.000Z";
function ticker(symbol = "601138", name = "Foxconn Industrial Internet Co. Ltd."): TickerRecord {
  return { metadata: { ticker: symbol, exchange: "SSE", currency: "CNY", name, assetCategory: "STK",
    portfolios: ["main"], watchlists: ["watch"], positions: [{ portfolio: "main", shares: 0, avgCost: 0, broker: "manual" }],
    broker_contracts: [], tags: ["keep"], custom: { unrelated: { value: "keep" } } } };
}
function identity(name = "工业富联", orgId = "990001") {
  return parseResearchIdentity("601138.SH", { data: { schemaVersion: 1, mode: "cninfo_shsz_identity", symbol: "601138.SH", code: "601138", exchange: "SSE",
    exchangeBasis: "code_prefix_route", identityBasis: "official_exact_current_code", name, orgId,
    officialIdentity: { code: "601138", category: "A股", type: "shj", delisted: "false", orgId, zwjc: name, pinyin: "gyfl" },
    source: { provider: "cninfo", sourceURL: "https://www.cninfo.com.cn/new/information/topSearch/query?keyWord=601138&maxNum=10", receivedAt: time, sha256: "a".repeat(64), sourceVersion: null } },
    meta: { mode: "cninfo_shsz_identity", receivedAt: time, returnedAt: time, fromCache: false } });
}
function cloud(overrides: Partial<InstrumentSearchResult> = {}): InstrumentSearchResult {
  return { providerId: "gloomberb-cloud", symbol: "601138", exchange: "SSE", currency: "CNY", type: "EQUITY", name: ticker().metadata.name, ...overrides };
}
function quote(overrides: Partial<Quote> = {}): Quote {
  return { symbol: "601138.SS", currency: "CNY", providerId: "gloomberb-cloud", name: ticker().metadata.name,
    instrumentType: "EQUITY", listingExchangeName: "XSHG", price: 20, change: 0, changePercent: 0, lastUpdated: Date.parse(time), ...overrides };
}
function fixture(records = [ticker()]) {
  const stored = new Map(records.map((record) => [record.metadata.ticker, structuredClone(record)]));
  const settings = new Map<string, Record<string, unknown>>();
  const config = { portfolios: [{ id: "main" }], watchlists: [{ id: "watch" }], layout: { instances: [] },
    pluginConfig: { "ashare-local": { nameDisplay: "chinese" } } } as unknown as ReturnType<GloomPluginContext["getConfig"]>;
  const saved: TickerRecord[] = [], searchCalls: string[] = [], columnWrites: unknown[][] = [];
  let rows: InstrumentSearchResult[] = [cloud()], heldQuote: Quote | null = null;
  const ctx: Parameters<typeof syncNativeNames>[0] = {
    getConfig: () => config,
    getData: () => heldQuote ? { quote: heldQuote } as TickerFinancials : null,
    tickerRepository: {
      loadAllTickers: async () => Array.from(stored.values(), (record) => structuredClone(record)),
      loadTicker: async (symbol) => { const record = stored.get(symbol); return record ? structuredClone(record) : null; },
      saveTicker: async (record) => { saved.push(structuredClone(record)); stored.set(record.metadata.ticker, structuredClone(record)); },
      createTicker: async (metadata) => ({ metadata }), deleteTicker: async () => {},
    },
    marketData: { search: async (query) => { searchCalls.push(query); return structuredClone(rows); } } as GloomPluginContext["marketData"],
    paneSettings: {
      get: (pane, key) => (settings.get(pane)?.[key] ?? null) as never,
      set: async (pane, key, value) => { columnWrites.push([pane, key, value]); settings.set(pane, { ...settings.get(pane), [key]: value }); },
      delete: async () => {},
    },
  };
  return { ctx, stored, config, settings, saved, columnWrites, searchCalls,
    setRows: (next: InstrumentSearchResult[]) => { rows = next; }, setQuote: (next: Quote) => { heldQuote = next; } };
}
const load: LoadResearchIdentity = async () => identity();

test("native NAME keeps user order, deduplicates and preserves defaults and untouched grids", async () => {
  expect(withNativeNameColumn(["price", "name", "ticker", "name", "pnl", "custom"])).toEqual(["price", "name", "ticker", "pnl", "custom"]);
  expect(withNativeNameColumn(["price", "ticker", "pnl", "custom"])).toEqual(["price", "ticker", "name", "pnl", "custom"]);
  const f = fixture();
  f.config.layout.instances = [
    { instanceId: "table", paneId: "portfolio-list", binding: { kind: "none" } },
    { instanceId: "grid", paneId: "portfolio-list", binding: { kind: "none" } },
    { instanceId: "other", paneId: "news", binding: { kind: "none" } },
  ];
  f.settings.set("grid", { viewMode: "grid", columnIds: ["ticker", "pnl"] });
  const result = await enableNativeNameColumns(f.ctx);
  expect(result).toEqual({ changed: ["table"], skippedGrid: ["grid"] });
  expect(f.columnWrites).toHaveLength(1);
  expect(f.settings.get("table")?.columnIds).toContain("name");
  expect((f.settings.get("table")?.columnIds as string[]).slice(0, 2)).toEqual(["ticker", "name"]);
  expect(f.settings.get("grid")).toEqual({ viewMode: "grid", columnIds: ["ticker", "pnl"] });
  expect((await enableNativeNameColumns(f.ctx)).changed).toEqual([]);
});

test("blank/code names sync verified Chinese and preserve zero positions plus all metadata", async () => {
  const record = ticker("601138:XSHG", "601138"), f = fixture([record]);
  const result = await syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false, now: () => time });
  expect(f.searchCalls).toEqual([]);
  expect(result.changedRecords).toHaveLength(1);
  const saved = f.saved[0]!;
  expect(saved.metadata.name).toBe("工业富联");
  expect(saved.metadata.positions).toEqual(record.metadata.positions);
  expect(saved.metadata.portfolios).toEqual(record.metadata.portfolios);
  expect(saved.metadata.watchlists).toEqual(record.metadata.watchlists);
  expect(saved.metadata.tags).toEqual(record.metadata.tags);
  expect(saved.metadata.custom.unrelated).toEqual(record.metadata.custom.unrelated);
  expect(saved.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ previousName: "601138", appliedName: "工业富联", ownershipBasis: "placeholder", orgId: "990001" });
});

test("real exact Cloud name evidence authorizes an old provider name, not a guessed English name", async () => {
  const held = ticker(); held.metadata.assetCategory = "Common Stock";
  const f = fixture([held]); f.setRows([cloud({ type: "Common Stock" })]);
  const result = await syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false });
  expect(f.searchCalls).toEqual(["601138"]);
  expect(result.changedRecords[0]?.metadata.name).toBe("工业富联");
  expect(f.saved[0]?.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ previousName: ticker().metadata.name, ownershipBasis: "cloud_search", providerEvidence: { providerId: "gloomberb-cloud", currency: "CNY" } });
  const custom = fixture([ticker("601138", "My Long-term Holding")]);
  await syncNativeNames(custom.ctx, { identityLoad: load, updateColumns: false });
  expect(custom.saved).toEqual([]);
  expect(custom.stored.get("601138")?.metadata.name).toBe("My Long-term Holding");
});

test("cache evidence requires same listing, currency and native provider", async () => {
  const good = fixture(); good.setQuote(quote());
  await syncNativeNames(good.ctx, { identityLoad: load, updateColumns: false });
  expect(good.searchCalls).toEqual([]);
  expect(good.saved[0]?.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ ownershipBasis: "native_quote" });
  for (const invalid of [{ symbol: "601139" }, { listingExchangeName: "XSHE" }, { currency: "USD" }, { providerId: "untrusted" }, { instrumentType: "ETF" }]) {
    const f = fixture(); f.setQuote(quote(invalid)); f.setRows([]);
    await syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false });
    expect(f.saved).toEqual([]);
  }
});

test("wrong Cloud issuer, exchange, currency, type and foreign provider cannot rename", async () => {
  for (const invalid of [{ symbol: "601139" }, { exchange: "XSHE" }, { currency: "USD" }, { currency: undefined }, { type: "ETF" }, { providerId: "custom-source" }]) {
    const f = fixture(); f.setRows([cloud(invalid)]);
    const result = await syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false });
    expect(f.saved).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("preserved_custom_name");
  }
});

test("foreign stocks, ETFs, Beijing and nonmembers never reach identity or market search", async () => {
  const foreign = ticker("AAPL", "Apple"), etf = ticker("601138", "ETF"), bj = ticker("920185.BJ", "贝特"), absent = ticker("601139", "My note");
  foreign.metadata.exchange = "NASDAQ"; foreign.metadata.currency = "USD";
  etf.metadata.assetCategory = "ETF";
  bj.metadata.exchange = "BJSE";
  absent.metadata.portfolios = []; absent.metadata.watchlists = []; absent.metadata.positions = [];
  const f = fixture([foreign, etf, bj, absent]); let identityCalls = 0;
  const result = await syncNativeNames(f.ctx, { identityLoad: async () => { identityCalls++; return identity(); }, updateColumns: false });
  expect(identityCalls).toBe(0); expect(f.searchCalls).toEqual([]); expect(f.saved).toEqual([]); expect(result.skipped).toHaveLength(4);
});

test("official issuer conflict and incorrect lookup response are rejected", async () => {
  const record = ticker("601138", "601138"); record.metadata.custom.ashareChineseIdentity = { symbol: "601138.SH", orgId: "different" };
  const f = fixture([record]);
  expect((await syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false })).skipped[0]?.reason).toBe("issuer_identity_conflict");
  expect(f.saved).toEqual([]);
  const wrong = fixture([ticker("601138", "601138")]);
  await syncNativeNames(wrong.ctx, { identityLoad: async () => { const raw = identity(); raw.data.code = "601139"; return raw; }, updateColumns: false });
  expect(wrong.saved).toEqual([]);
});

test("a concurrent holding/custom edit is merged from the fresh repository record", async () => {
  const f = fixture(), pending = Promise.withResolvers<ReturnType<typeof identity>>();
  const task = syncNativeNames(f.ctx, { identityLoad: () => pending.promise, updateColumns: false });
  await Promise.resolve(); await Promise.resolve();
  const latest = f.stored.get("601138")!;
  latest.metadata.positions = [{ portfolio: "main", shares: 123, avgCost: 0, broker: "manual" }];
  latest.metadata.custom.unrelated = { value: "edited" }; latest.metadata.tags.push("new");
  pending.resolve(identity()); await task;
  expect(f.saved[0]?.metadata.positions).toEqual(latest.metadata.positions);
  expect(f.saved[0]?.metadata.custom.unrelated).toEqual({ value: "edited" });
  expect(f.saved[0]?.metadata.tags).toEqual(["keep", "new"]);
});

test("a name or currency edit during lookup is preserved rather than overwritten", async () => {
  for (const nameEdit of [true, false]) {
    const f = fixture(), pending = Promise.withResolvers<ReturnType<typeof identity>>();
    const task = syncNativeNames(f.ctx, { identityLoad: () => pending.promise, updateColumns: false });
    await Promise.resolve(); await Promise.resolve();
    const latest = f.stored.get("601138")!;
    if (nameEdit) latest.metadata.name = "我自己的公司标签"; else latest.metadata.currency = "USD";
    pending.resolve(identity()); await task;
    expect(f.saved).toEqual([]);
    expect(f.stored.get("601138")?.metadata.name).toBe(latest.metadata.name);
  }
});

test("plugin-owned rename preserves original previousName and stops after user overrides it", async () => {
  const f = fixture([ticker("601138", "601138")]);
  await syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false });
  await syncNativeNames(f.ctx, { identityLoad: async () => identity("工业富联新简称"), updateColumns: false });
  const second = f.saved[1]!;
  expect(second.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ appliedName: "工业富联新简称", previousName: "601138", ownershipBasis: "plugin_owned" });
  const owned = second.metadata.custom[NATIVE_NAME_PROVENANCE_KEY] as NativeNameProvenance;
  expect(owned.source.receivedAt).toBe(time);
  f.stored.get("601138")!.metadata.name = "自定标签"; f.setRows([]);
  await syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false });
  expect(f.saved).toHaveLength(2);
});

test("aborted and late identity responses cannot save or notify", async () => {
  const f = fixture([ticker("601138", "601138")]), pending = Promise.withResolvers<ReturnType<typeof identity>>(), controller = new AbortController();
  let notices = 0;
  const task = syncNativeNames(f.ctx, { identityLoad: () => pending.promise, signal: controller.signal, updateColumns: false, onSaved: () => { notices++; } });
  await Promise.resolve(); await Promise.resolve(); controller.abort(); pending.resolve(identity());
  await expect(task).rejects.toThrow();
  expect(f.saved).toEqual([]); expect(notices).toBe(0);
});

test("lifecycle is finite, handles native additions and aborts queued work on shutdown", async () => {
  const f = fixture([ticker("601138", "601138")]);
  let added: ((payload: { symbol: string; ticker: TickerRecord }) => void) | null = null, unsubscribed = false;
  const lifecycleCtx = { ...f.ctx,
    on: ((event: string, handler: typeof added) => { if (event === "ticker:added") added = handler; return () => { unsubscribed = true; }; }) as GloomPluginContext["on"],
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
  const lifecycle = createNativeNameLifecycle(lifecycleCtx, { identityLoad: load, updateColumns: false });
  await lifecycle.ready;
  expect(f.saved).toHaveLength(1);
  (added as unknown as (payload: { symbol: string; ticker: TickerRecord }) => void)({ symbol: "601138", ticker: ticker() });
  await lifecycle.sync();
  expect(f.saved).toHaveLength(1);
  lifecycle.shutdown(); expect(unsubscribed).toBeTrue();
  await expect(lifecycle.sync()).rejects.toThrow();
  expect(f.saved).toHaveLength(1);
});

// The public 0.15.8 search response for the reported company. No profile or
// network is used: inject failures around the production sync and recovery.
function tengyuan() {
  const record = ticker("301219", "Ganzhou Tengyuan Cobalt Co., Ltd.");
  record.metadata.exchange = "SZSE"; record.metadata.assetCategory = "Common Stock";
  const raw = identity("腾远钴业", "9900035080");
  raw.data.symbol = "301219.SZ"; raw.data.code = "301219"; raw.data.exchange = "SZSE";
  raw.data.officialIdentity.code = "301219"; raw.data.officialIdentity.pinyin = "tygy";
  raw.data.source.sourceURL = "https://www.cninfo.com.cn/new/information/topSearch/query?keyWord=301219&maxNum=10";
  const row = cloud({ symbol: "301219", exchange: "SZSE", type: "Common Stock", name: record.metadata.name });
  return { record, raw, row };
}
function recoveryFixture() {
  const t = tengyuan(), f = fixture([t.record]); f.setRows([t.row]);
  const warnings: string[] = [], infos: string[] = [];
  const gate = Promise.withResolvers<void>(), scheduled = Promise.withResolvers<void>();
  let waits = 0;
  const ctx = { ...f.ctx, on: (() => () => {}) as GloomPluginContext["on"],
    log: { debug() {}, info(message: string) { infos.push(message); }, warn(message: string) { warnings.push(message); }, error() {} } };
  const waitForRetry = async (signal: AbortSignal) => {
    waits++; scheduled.resolve(); signal.throwIfAborted();
    const abort = () => gate.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try { await gate.promise; signal.throwIfAborted(); }
    finally { signal.removeEventListener("abort", abort); }
  };
  return { ...f, ...t, ctx, warnings, infos, scheduled: scheduled.promise, release: () => gate.resolve(), waitForRetry, waits: () => waits };
}

test("Tengyuan recovers once after identity, search or save failure without a membership event", async () => {
  for (const stage of ["identity", "search", "save"] as const) {
    const f = recoveryFixture(); let failures = 0;
    const failOnce = () => { if (failures++ === 0) throw new Error("private path/token must not be logged"); };
    const search = f.ctx.marketData.search.bind(f.ctx.marketData), save = f.ctx.tickerRepository.saveTicker;
    if (stage === "search") f.ctx.marketData.search = async (...args) => { failOnce(); return search(...args); };
    if (stage === "save") f.ctx.tickerRepository.saveTicker = async (record) => { failOnce(); await save(record); };
    const lifecycle = createNativeNameLifecycle(f.ctx, { identityLoad: async () => { if (stage === "identity") failOnce(); return f.raw; },
      updateColumns: false, waitForRetry: f.waitForRetry });
    await f.scheduled;
    expect(f.stored.get("301219")?.metadata.name).toBe(f.record.metadata.name);
    expect(f.warnings[0]).toContain(`stage=${stage}`);
    f.release(); const result = await lifecycle.ready;
    expect(f.waits()).toBe(1); expect(f.saved).toHaveLength(1); expect(result.skipped).toEqual([]);
    const updated = f.saved[0]!;
    expect(updated.metadata.name).toBe("腾远钴业");
    expect(updated.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ ownershipBasis: "cloud_search", previousName: f.record.metadata.name });
    const { name, custom, ...protectedMetadata } = updated.metadata;
    const { name: oldName, custom: oldCustom, ...originalMetadata } = f.record.metadata;
    expect(protectedMetadata).toEqual(originalMetadata); expect(custom.unrelated).toEqual(oldCustom.unrelated);
    expect(f.warnings.join(" ")).not.toContain("private path/token");
    lifecycle.shutdown();
  }
});

test("empty native search is deferred evidence and retries only the failed stock once", async () => {
  const f = recoveryFixture(); f.setRows([]);
  const alreadyNamed = ticker("601138", "工业富联"); f.stored.set("601138", alreadyNamed);
  const identities: string[] = [];
  const lifecycle = createNativeNameLifecycle(f.ctx, { identityLoad: async (symbol) => { identities.push(symbol); return symbol === "301219.SZ" ? f.raw : identity(); },
    updateColumns: false, waitForRetry: f.waitForRetry });
  await f.scheduled;
  expect(f.warnings[0]).toContain("provider_evidence_unavailable");
  f.setRows([f.row]); f.release(); await lifecycle.ready;
  expect(identities).toEqual(["301219.SZ", "601138.SH", "301219.SZ"]);
  expect(f.searchCalls).toEqual(["301219", "301219"]); expect(f.waits()).toBe(1);
  expect(f.saved.map((record) => record.metadata.name)).toEqual(["腾远钴业"]);
  lifecycle.shutdown();
});

test("persistent missing evidence exhausts its retry and does not rename or expose failure text", async () => {
  const f = recoveryFixture(); f.setRows([]);
  const lifecycle = createNativeNameLifecycle(f.ctx, { identityLoad: async () => f.raw, updateColumns: false, waitForRetry: f.waitForRetry });
  await f.scheduled; f.release(); const result = await lifecycle.ready;
  await Promise.resolve(); await Promise.resolve();
  expect(f.searchCalls).toHaveLength(2); expect(f.waits()).toBe(1); expect(f.saved).toEqual([]);
  expect(result.skipped[0]).toMatchObject({ symbol: "301219", reason: "provider_evidence_unavailable", retryable: true });
  expect(f.warnings.at(-1)).toContain("retry exhausted"); lifecycle.shutdown();
});

test("a retry rechecks concurrent custom name, holdings, membership, currency and issuer edits", async () => {
  for (const edit of ["name", "holdings", "membership", "currency", "issuer"] as const) {
    const f = recoveryFixture(); f.setRows([]);
    const lifecycle = createNativeNameLifecycle(f.ctx, { identityLoad: async () => f.raw, updateColumns: false, waitForRetry: f.waitForRetry });
    await f.scheduled;
    const current = f.stored.get("301219")!;
    if (edit === "name") current.metadata.name = "我的自定义名称";
    if (edit === "holdings") { current.metadata.positions[0]!.shares = 321; current.metadata.custom.unrelated = { value: "edited" }; }
    if (edit === "membership") { current.metadata.portfolios = []; current.metadata.watchlists = []; current.metadata.positions = []; }
    if (edit === "currency") current.metadata.currency = "USD";
    if (edit === "issuer") current.metadata.custom.ashareChineseIdentity = { orgId: "another-issuer" };
    f.setRows([f.row]); f.release(); await lifecycle.ready;
    if (edit === "holdings") {
      expect(f.saved[0]?.metadata.name).toBe("腾远钴业"); expect(f.saved[0]?.metadata.positions[0]?.shares).toBe(321);
      expect(f.saved[0]?.metadata.custom.unrelated).toEqual({ value: "edited" });
    } else expect(f.saved).toEqual([]);
    expect(f.waits()).toBe(1); lifecycle.shutdown();
  }
});

test("shutdown cancels a scheduled retry and late recovery cannot save", async () => {
  const f = recoveryFixture(); f.setRows([]);
  const lifecycle = createNativeNameLifecycle(f.ctx, { identityLoad: async () => f.raw, updateColumns: false, waitForRetry: f.waitForRetry });
  await f.scheduled; lifecycle.shutdown(); f.setRows([f.row]); f.release();
  await expect(lifecycle.ready).rejects.toThrow();
  expect(f.searchCalls).toHaveLength(1); expect(f.saved).toEqual([]);
  const controller = new AbortController(), pending = waitForNativeNameRetry(controller.signal);
  controller.abort(); await expect(pending).rejects.toThrow();
});

function ownedChinese(previousName = ticker().metadata.name): TickerRecord {
  const record = ticker("601138", "工业富联");
  const prior: NativeNameProvenanceV1 = { schemaVersion: 1, managedBy: "ashare-local", symbol: "601138.SH", code: "601138", exchange: "SSE",
    orgId: "990001", previousName, appliedName: record.metadata.name, appliedAt: time, ownershipBasis: "cloud_search",
    source: structuredClone(identity().data.source), providerEvidence: { providerId: "gloomberb-cloud", symbol: "601138", exchange: "SSE", currency: "CNY", name: previousName } };
  record.metadata.custom[NATIVE_NAME_PROVENANCE_KEY] = prior;
  return record;
}

test("default bilingual uses current exact-code English, migrates v1 unchanged Chinese and is idempotent", async () => {
  const record = ownedChinese("Former Official English Name"), f = fixture([record]);
  delete f.config.pluginConfig["ashare-local"];
  f.setRows([cloud({ name: "Current Official English Name" })]);
  const first = await syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false, now: () => time });
  expect(first.changedRecords).toHaveLength(1);
  expect(f.saved[0]?.metadata.name).toBe("工业富联 · Current Official English Name");
  expect(f.saved[0]?.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ schemaVersion: 2,
    chineseName: "工业富联", englishName: "Current Official English Name", displayMode: "bilingual", previousName: "Former Official English Name",
    englishNameEvidence: { providerId: "gloomberb-cloud", symbol: "601138", currency: "CNY", instrumentType: "EQUITY", observedAt: time } });
  expect(parseNativeNameProvenance(f.saved[0]?.metadata.custom[NATIVE_NAME_PROVENANCE_KEY])?.schemaVersion).toBe(2);
  expect(f.saved[0]?.metadata.positions).toEqual(record.metadata.positions);
  expect(f.searchCalls).toEqual(["601138"]);
  const second = await syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false, now: () => "2026-10-04T05:00:00.000Z" });
  expect(second.changedRecords).toEqual([]); expect(f.saved).toHaveLength(1); expect(f.searchCalls).toEqual(["601138"]);
});

test("bilingual placeholders discover native Yahoo English and preserve all saved metadata", async () => {
  const record = ticker("601138:XSHG", "601138"), f = fixture([record]);
  delete f.config.pluginConfig["ashare-local"];
  f.setRows([cloud({ providerId: "yahoo-finance", symbol: "601138.SS", exchange: "XSHG", name: "Foxconn Industrial Internet Co., Ltd." })]);
  await syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false, now: () => time });
  const saved = f.saved[0]!;
  expect(saved.metadata.name).toBe("工业富联 · Foxconn Industrial Internet Co., Ltd.");
  expect(saved.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ previousName: "601138", ownershipBasis: "placeholder", englishNameEvidence: { providerId: "yahoo-finance" } });
  const { name, custom, ...protectedMetadata } = saved.metadata;
  const { name: oldName, custom: oldCustom, ...originalMetadata } = record.metadata;
  expect(protectedMetadata).toEqual(originalMetadata); expect(custom.unrelated).toEqual(oldCustom.unrelated);
});

test("valid English evidence never grants permission to replace a user-authored name", async () => {
  const f = fixture([ticker("601138", "我的公司笔记")]); delete f.config.pluginConfig["ashare-local"];
  f.setRows([cloud()]); f.setQuote(quote());
  const result = await syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false });
  expect(f.saved).toEqual([]); expect(result.skipped[0]?.reason).toBe("preserved_custom_name");
});

test("v1 migration cannot turn historical previousName into English; unavailable English keeps Chinese with one retry", async () => {
  const f = fixture([ownedChinese("Historical English Name")]); delete f.config.pluginConfig["ashare-local"]; f.setRows([]);
  const gate = Promise.withResolvers<void>(), scheduled = Promise.withResolvers<void>(); let waits = 0;
  const ctx = { ...f.ctx, on: (() => () => {}) as GloomPluginContext["on"], log: { debug() {}, info() {}, warn() {}, error() {} } };
  const lifecycle = createNativeNameLifecycle(ctx, { identityLoad: load, updateColumns: false,
    waitForRetry: async () => { waits++; scheduled.resolve(); await gate.promise; } });
  await scheduled.promise;
  expect(f.saved).toHaveLength(1); expect(f.saved[0]?.metadata.name).toBe("工业富联");
  expect(f.saved[0]?.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ schemaVersion: 2, displayMode: "bilingual",
    englishName: null, englishNameEvidence: null, previousName: "Historical English Name" });
  gate.resolve(); const result = await lifecycle.ready;
  expect(waits).toBe(1); expect(f.searchCalls).toEqual(["601138", "601138"]); expect(f.saved).toHaveLength(1);
  expect(result.skipped[0]).toMatchObject({ reason: "english_name_evidence_unavailable", retryable: true }); lifecycle.shutdown();
});

test("English mode without a usable native English name preserves the verified Chinese fallback", async () => {
  const f = fixture([ownedChinese("601138")]); f.config.pluginConfig["ashare-local"] = { nameDisplay: "english" };
  f.setRows([cloud({ name: "工业富联" })]);
  const result = await syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false });
  expect(f.saved[0]?.metadata.name).toBe("工业富联");
  expect(f.saved[0]?.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ schemaVersion: 2, displayMode: "english", englishName: null, englishNameEvidence: null });
  expect(result.skipped).toEqual([]);
});

test("verified native quote English can fill a placeholder while search is empty or unavailable", async () => {
  for (const failedSearch of [false, true]) {
    const f = fixture([ticker("601138", "601138")]); delete f.config.pluginConfig["ashare-local"];
    f.setRows([]); f.setQuote(quote({ providerId: "yahoo-finance" }));
    if (failedSearch) f.ctx.marketData.search = async () => { throw new Error("private failure"); };
    const result = await syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false, now: () => time });
    expect(f.saved[0]?.metadata.name).toBe(formatNativeName("工业富联", ticker().metadata.name, "bilingual"));
    expect(f.saved[0]?.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ englishNameEvidence: { providerId: "yahoo-finance", observedAt: time }, ownershipBasis: "placeholder" });
    expect(result.skipped).toEqual([]);
  }
});

test("English lookup rechecks user edits, mode changes and cancellation before saving migrated names", async () => {
  for (const edit of ["name", "membership", "currency", "issuer", "mode", "abort"] as const) {
    const f = fixture([ownedChinese()]); delete f.config.pluginConfig["ashare-local"];
    const pending = Promise.withResolvers<InstrumentSearchResult[]>(), started = Promise.withResolvers<void>(), controller = new AbortController();
    f.ctx.marketData.search = async () => { started.resolve(); return pending.promise; };
    const task = syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false, signal: controller.signal });
    await started.promise;
    const current = f.stored.get("601138")!;
    if (edit === "name") current.metadata.name = "我的新标签";
    if (edit === "membership") { current.metadata.portfolios = []; current.metadata.watchlists = []; current.metadata.positions = []; }
    if (edit === "currency") current.metadata.currency = "USD";
    if (edit === "issuer") current.metadata.custom.ashareChineseIdentity = { orgId: "another" };
    if (edit === "mode") f.config.pluginConfig["ashare-local"] = { nameDisplay: "chinese" };
    if (edit === "abort") controller.abort();
    pending.resolve([cloud()]);
    if (edit === "abort") await expect(task).rejects.toThrow(); else await task;
    expect(f.saved).toEqual([]);
  }
});

test("bilingual migration merges zero and edited holdings from a fresh record after English lookup", async () => {
  const f = fixture([ownedChinese()]); delete f.config.pluginConfig["ashare-local"];
  const pending = Promise.withResolvers<InstrumentSearchResult[]>(), started = Promise.withResolvers<void>();
  f.ctx.marketData.search = async () => { started.resolve(); return pending.promise; };
  const task = syncNativeNames(f.ctx, { identityLoad: load, updateColumns: false }); await started.promise;
  const current = f.stored.get("601138")!;
  current.metadata.positions.push({ portfolio: "main", shares: 321, avgCost: 88, broker: "edited" });
  current.metadata.tags.push("edited"); current.metadata.custom.unrelated = { value: "edited" };
  pending.resolve([cloud()]); await task;
  expect(f.saved[0]?.metadata.positions).toEqual(current.metadata.positions);
  expect(f.saved[0]?.metadata.positions[0]?.shares).toBe(0);
  expect(f.saved[0]?.metadata.tags).toEqual(["keep", "edited"]);
  expect(f.saved[0]?.metadata.custom.unrelated).toEqual({ value: "edited" });
});

test("TUI lifecycle reacts only to nameDisplay changes and preserves verified English across mode changes", async () => {
  const f = fixture([ownedChinese()]); delete f.config.pluginConfig["ashare-local"];
  const handlers = new Map<string, () => void>(); let identityCalls = 0, unsubscribed = 0;
  const chineseSaved = Promise.withResolvers<void>(), englishSaved = Promise.withResolvers<void>();
  const ctx = { ...f.ctx, on: ((event: string, handler: () => void) => { handlers.set(event, handler); return () => { handlers.delete(event); unsubscribed++; }; }) as GloomPluginContext["on"],
    log: { debug() {}, info() {}, warn() {}, error() {} } };
  const lifecycle = createNativeNameLifecycle(ctx, { identityLoad: async () => { identityCalls++; return identity(); }, updateColumns: false,
    onSaved: (record) => { if (record.metadata.name === "工业富联") chineseSaved.resolve(); else if (record.metadata.name === ticker().metadata.name) englishSaved.resolve(); } });
  await lifecycle.ready;
  expect(f.saved[0]?.metadata.name).toBe(formatNativeName("工业富联", ticker().metadata.name, "bilingual"));
  handlers.get("config:changed")!(); await Promise.resolve(); await Promise.resolve();
  expect(identityCalls).toBe(1); expect(f.saved).toHaveLength(1);
  f.config.pluginConfig["ashare-local"] = { nameDisplay: "chinese" }; handlers.get("config:changed")!(); await chineseSaved.promise;
  expect(f.saved[1]?.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ displayMode: "chinese", englishName: ticker().metadata.name });
  f.config.pluginConfig["ashare-local"] = { nameDisplay: "english" }; handlers.get("config:changed")!(); await englishSaved.promise;
  expect(f.saved[2]?.metadata.name).toBe(ticker().metadata.name);
  expect(f.saved[2]?.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ previousName: ticker().metadata.name, displayMode: "english" });
  expect(identityCalls).toBe(3); expect(f.searchCalls).toEqual(["601138"]);
  lifecycle.shutdown(); expect(unsubscribed).toBe(2); expect(handlers.size).toBe(0);
});

test("mode change cancels an outstanding English read and late old-mode results cannot write", async () => {
  const f = fixture([ownedChinese()]); delete f.config.pluginConfig["ashare-local"];
  const pending = Promise.withResolvers<InstrumentSearchResult[]>(), started = Promise.withResolvers<void>(), newModeSaved = Promise.withResolvers<void>();
  f.ctx.marketData.search = async () => { started.resolve(); return pending.promise; };
  const handlers = new Map<string, () => void>();
  const ctx = { ...f.ctx, on: ((event: string, handler: () => void) => { handlers.set(event, handler); return () => { handlers.delete(event); }; }) as GloomPluginContext["on"],
    log: { debug() {}, info() {}, warn() {}, error() {} } };
  const lifecycle = createNativeNameLifecycle(ctx, { identityLoad: load, updateColumns: false, onSaved: () => newModeSaved.resolve() });
  const oldResult = lifecycle.ready.catch((error: unknown) => error);
  await started.promise;
  f.config.pluginConfig["ashare-local"] = { nameDisplay: "chinese" }; handlers.get("config:changed")!();
  await newModeSaved.promise;
  expect(await oldResult).toBeInstanceOf(DOMException);
  expect(f.saved).toHaveLength(1); expect(f.saved[0]?.metadata.name).toBe("工业富联");
  expect(f.saved[0]?.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ schemaVersion: 2, displayMode: "chinese", englishName: null });
  pending.resolve([cloud()]); await Promise.resolve(); await Promise.resolve();
  expect(f.saved).toHaveLength(1); lifecycle.shutdown();
});

test("mode change cancels an old retry delay before immediately running the new mode", async () => {
  const f = fixture([ownedChinese()]); delete f.config.pluginConfig["ashare-local"]; f.setRows([]);
  const scheduled = Promise.withResolvers<void>(), oldDelay = Promise.withResolvers<void>(), newModeSaved = Promise.withResolvers<void>();
  const handlers = new Map<string, () => void>(); let waits = 0;
  const ctx = { ...f.ctx, on: ((event: string, handler: () => void) => { handlers.set(event, handler); return () => { handlers.delete(event); }; }) as GloomPluginContext["on"],
    log: { debug() {}, info() {}, warn() {}, error() {} } };
  const lifecycle = createNativeNameLifecycle(ctx, { identityLoad: load, updateColumns: false,
    waitForRetry: async () => { waits++; scheduled.resolve(); await oldDelay.promise; },
    onSaved: (record) => { if (record.metadata.name === ticker().metadata.name) newModeSaved.resolve(); } });
  const oldResult = lifecycle.ready.catch((error: unknown) => error);
  await scheduled.promise;
  f.setRows([cloud()]); f.config.pluginConfig["ashare-local"] = { nameDisplay: "english" }; handlers.get("config:changed")!();
  await newModeSaved.promise;
  expect(await oldResult).toBeInstanceOf(DOMException);
  expect(waits).toBe(1); expect(f.searchCalls).toEqual(["601138", "601138"]);
  expect(f.saved.map((record) => record.metadata.name)).toEqual(["工业富联", ticker().metadata.name]);
  oldDelay.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(f.saved).toHaveLength(2); expect(f.searchCalls).toHaveLength(2); lifecycle.shutdown();
});

function dualOwned(record: TickerRecord, raw: ReturnType<typeof identity>): TickerRecord {
  const englishName = record.metadata.name, chineseName = raw.data.name;
  const provenance: NativeNameProvenanceV2 = { schemaVersion: 2, managedBy: "ashare-local", symbol: raw.data.symbol, code: raw.data.code,
    exchange: raw.data.exchange, orgId: raw.data.orgId, previousName: englishName, appliedName: formatNativeName(chineseName, englishName, "bilingual"),
    appliedAt: time, ownershipBasis: "plugin_owned", chineseName, englishName, displayMode: "bilingual", source: structuredClone(raw.data.source),
    providerEvidence: { providerId: "gloomberb-cloud", symbol: raw.data.code, exchange: raw.data.exchange, currency: "CNY", name: englishName },
    englishNameEvidence: { providerId: "gloomberb-cloud", symbol: raw.data.code, exchange: raw.data.exchange, currency: "CNY", name: englishName,
      instrumentType: "Common Stock", observedAt: time } };
  const updated = structuredClone(record); updated.metadata.name = provenance.appliedName;
  updated.metadata.custom[NATIVE_NAME_PROVENANCE_KEY] = provenance; return updated;
}
function luxshare() {
  const record = ticker("002475", "Luxshare Precision Industry Co., Ltd."); record.metadata.exchange = "SZSE";
  const raw = identity("立讯精密", "9900014448");
  raw.data.symbol = "002475.SZ"; raw.data.code = "002475"; raw.data.exchange = "SZSE";
  raw.data.officialIdentity.code = "002475"; raw.data.officialIdentity.pinyin = "lxjm";
  raw.data.source.sourceURL = "https://www.cninfo.com.cn/new/information/topSearch/query?keyWord=002475&maxNum=10";
  return { record, raw };
}

test("a delayed desktop config commit without a backend event immediately repairs only the first skipped member", async () => {
  const l = luxshare(), t = tengyuan(), f = fixture([dualOwned(l.record, l.raw), dualOwned(t.record, t.raw)]);
  delete f.config.pluginConfig["ashare-local"];
  const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<ReturnType<typeof identity>>();
  const calls: string[] = []; let waits = 0;
  const ctx = { ...f.ctx, on: (() => () => {}) as GloomPluginContext["on"], log: { debug() {}, info() {}, warn() {}, error() {} } };
  const lifecycle = createNativeNameLifecycle(ctx, { updateColumns: false, now: () => time,
    identityLoad: async (symbol) => {
      calls.push(symbol);
      if (calls.length === 1) { started.resolve(); return gate.promise; }
      return symbol === "002475.SZ" ? l.raw : t.raw;
    }, waitForRetry: async () => { waits++; } });
  await started.promise;
  const fresh = f.stored.get("002475")!;
  fresh.metadata.positions.push({ portfolio: "main", shares: 321, avgCost: 88, broker: "edited" });
  fresh.metadata.tags.push("edited"); fresh.metadata.custom.unrelated = { value: "edited" };
  const protectedBefore = structuredClone(fresh.metadata);
  // This reproduces the official desktop's dispatch -> async config.save
  // order. Its backend changes getConfig without emitting config:changed.
  f.config.pluginConfig["ashare-local"] = { nameDisplay: "english" }; gate.resolve(l.raw);
  const result = await lifecycle.ready;
  expect(result.skipped).toEqual([]); expect(result.changedRecords.map((record) => record.metadata.ticker)).toEqual(["301219", "002475"]);
  expect(calls).toEqual(["002475.SZ", "301219.SZ", "002475.SZ"]); expect(waits).toBe(0); expect(f.searchCalls).toEqual([]);
  expect(f.saved).toHaveLength(2);
  expect(f.stored.get("002475")?.metadata.name).toBe(l.record.metadata.name);
  expect(f.stored.get("301219")?.metadata.name).toBe(t.record.metadata.name);
  const saved = f.saved.find((record) => record.metadata.ticker === "002475")!;
  const { name, custom, ...protectedAfter } = saved.metadata;
  const { name: oldName, custom: oldCustom, ...expected } = protectedBefore;
  expect(protectedAfter).toEqual(expected); expect(saved.metadata.positions[0]?.shares).toBe(0);
  expect(custom.unrelated).toEqual(oldCustom.unrelated);
  expect(custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ displayMode: "english", previousName: l.record.metadata.name });
  lifecycle.shutdown();
});

test("a second mode change during immediate repair stays skipped and never starts a third attempt", async () => {
  const l = luxshare(), t = tengyuan(), f = fixture([dualOwned(l.record, l.raw), dualOwned(t.record, t.raw)]);
  delete f.config.pluginConfig["ashare-local"];
  const started = Promise.withResolvers<void>(), repairStarted = Promise.withResolvers<void>();
  const firstGate = Promise.withResolvers<ReturnType<typeof identity>>(), repairGate = Promise.withResolvers<ReturnType<typeof identity>>();
  let firstReads = 0, waits = 0;
  const ctx = { ...f.ctx, on: (() => () => {}) as GloomPluginContext["on"], log: { debug() {}, info() {}, warn() {}, error() {} } };
  const lifecycle = createNativeNameLifecycle(ctx, { updateColumns: false,
    identityLoad: async (symbol) => {
      if (symbol !== "002475.SZ") return t.raw;
      firstReads++;
      if (firstReads === 1) { started.resolve(); return firstGate.promise; }
      repairStarted.resolve(); return repairGate.promise;
    }, waitForRetry: async () => { waits++; } });
  await started.promise;
  f.config.pluginConfig["ashare-local"] = { nameDisplay: "english" }; firstGate.resolve(l.raw);
  await repairStarted.promise;
  f.config.pluginConfig["ashare-local"] = { nameDisplay: "chinese" }; repairGate.resolve(l.raw);
  const result = await lifecycle.ready;
  expect(result.skipped).toEqual([{ symbol: "002475", reason: "name_display_mode_changed", stage: "record" }]);
  expect(firstReads).toBe(2); expect(waits).toBe(0); expect(f.searchCalls).toEqual([]);
  expect(f.saved.map((record) => record.metadata.ticker)).toEqual(["301219"]);
  expect(f.stored.get("002475")?.metadata.name).toBe(formatNativeName("立讯精密", l.record.metadata.name, "bilingual"));
  lifecycle.shutdown();
});
