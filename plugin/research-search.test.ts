import { expect, test } from "bun:test";
import type { AppConfig } from "gloomberb/types/config";
import type { CommandBarResultDef, CommandBarSearchContext } from "gloomberb/types/plugin";
import type { TickerMetadata, TickerRecord } from "gloomberb/types/ticker";
import type { BridgeResult } from "./client";
import { parseResearchIdentity, parseResearchSearch,
  type ResearchIdentityData, type ResearchSearchCandidate } from "./research-identity";
import { createResearchSearchProvider, type ResearchSearchProvider } from "./research-search";

// Explicit synthetic source contracts: no fixture is a live issuer claim and
// no test requests HTTP, market data, user holdings or the ordinary profile.
const receivedAt = "2026-10-04T04:00:00.000Z";
const context: CommandBarSearchContext = { activeTicker: null, activeCollectionId: null };
function candidate(code = "600000", name = "浦发银行", orgId = "fixture-pfyh"): ResearchSearchCandidate {
  return { symbol: `${code}.${code.startsWith("6") ? "SH" : "SZ"}`, code,
    exchange: code.startsWith("6") ? "SSE" : "SZSE", name, orgId, category: "A股",
    exchangeBasis: "code_prefix_route", officialInitials: "pfyh", fullPinyin: "pufayinhang",
    generatedInitials: "pfyh", matchKind: "initials_exact", identityBasis: "directory_index" };
}
function search(query: string, candidates = [candidate()]) {
  return parseResearchSearch(query, { data: { schemaVersion: 1, mode: "cninfo_shsz_search", query,
    normalizedQuery: query.toLowerCase(), limit: 10, totalMatches: candidates.length, candidates,
    pinyin: { provider: "pypinyin", version: "fixture", derived: true },
    source: { provider: "cninfo", sourceURL: "https://www.cninfo.com.cn/new/data/szse_stock.json",
      receivedAt, sha256: "a".repeat(64), sourceVersion: null }, limitations: ["Synthetic offline contract."] },
    meta: { mode: "cninfo_shsz_search", receivedAt, returnedAt: receivedAt, fixtureOnly: true } });
}
function identity(selected = candidate(), name = selected.name) {
  return parseResearchIdentity(selected.symbol, { data: { schemaVersion: 1, mode: "cninfo_shsz_identity",
    ...selected, name, identityBasis: "official_exact_current_code",
    officialIdentity: { code: selected.code, category: "A股", type: "shj", delisted: "false", orgId: selected.orgId,
      zwjc: name, pinyin: selected.officialInitials },
    source: { provider: "cninfo", sourceURL: `https://www.cninfo.com.cn/new/information/topSearch/query?keyWord=${selected.code}&maxNum=10`,
      receivedAt, sha256: "b".repeat(64), sourceVersion: null } },
    meta: { mode: "cninfo_shsz_identity", receivedAt, returnedAt: receivedAt, fixtureOnly: true } });
}
function ticker(symbol = "600000:XSHG", name = "My saved company label"): TickerRecord {
  return { metadata: { ticker: symbol, name, exchange: "SSE", currency: "CNY", assetCategory: "Common Stock",
    portfolios: ["main"], watchlists: ["watch"], positions: [{ portfolio: "main", shares: 42, avgCost: 0, broker: "manual" }],
    broker_contracts: [], custom: { note: "keep" }, tags: ["saved"] } };
}
function fixture(seeds: TickerRecord[] = []) {
  const config = { watchlists: [{ id: "watch", name: "Watchlist" }],
    portfolios: [{ id: "main", name: "Main Portfolio", currency: "CNY" }], disabledPlugins: [] } as unknown as AppConfig;
  const stored = new Map(seeds.map((record) => [record.metadata.ticker, structuredClone(record)]));
  const writes: TickerRecord[] = [], pins: { key: string; options: unknown }[] = [], notices: unknown[] = [],
    events: unknown[] = [], opened: string[] = [], timeline: string[] = [], logs: string[] = [], reads: string[] = [];
  let onLoad: ((key: string, count: number) => void) | null = null;
  const ctx: Parameters<typeof createResearchSearchProvider>[0] = {
    getConfig: () => config,
    openCommandBar: (query = "") => { opened.push(query); timeline.push(`open:${query}`); },
    tickerRepository: {
      async loadTicker(key) {
        reads.push(key);
        const current = stored.get(key), snapshot = current ? structuredClone(current) : null;
        onLoad?.(key, reads.length);
        return snapshot;
      },
      async loadAllTickers() { return Array.from(stored.values(), (record) => structuredClone(record)); },
      async createTicker(metadata: TickerMetadata) {
        const record = { metadata: structuredClone(metadata) };
        writes.push(structuredClone(record)); stored.set(metadata.ticker, record); return record;
      },
      async saveTicker(record) { writes.push(structuredClone(record)); stored.set(record.metadata.ticker, structuredClone(record)); },
      async deleteTicker() { throw new Error("This search never deletes records"); },
    },
    pinTicker: (key, options) => { pins.push({ key, options }); },
    emit: ((name: string, payload: unknown) => { events.push({ name, payload }); }) as Parameters<typeof createResearchSearchProvider>[0]["emit"],
    notify: (notice) => { notices.push(notice); },
    log: { debug() {}, info() {}, warn(message) { logs.push(message); }, error() {} },
  };
  return { ctx, config, stored, writes, pins, events, notices, opened, timeline, logs, reads,
    setLoadHook: (hook: typeof onLoad) => { onLoad = hook; } };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const rowsFor = (provider: ResearchSearchProvider, query = "PFYH") => provider.provide(query, context, new AbortController().signal);
const rowFor = (rows: CommandBarResultDef[], action: "research" | "watchlist" | "portfolio", symbol = "600000.SH") => {
  const row = rows.find((item) => item.id === `ashare-search:${symbol}${action === "research" ? "" : `:${action}`}`);
  if (!row) throw new Error(`Missing ${action} row for ${symbol}`);
  return row;
};
const loaders = { searchLoad: async (query: string) => search(query), identityLoad: async () => identity() };

test("typing Chinese, pinyin, initials or code returns explicit actions without any persistence", async () => {
  const f = fixture(), provider = createResearchSearchProvider(f.ctx, loaders);
  try {
    for (const query of ["浦发银行", "pufayinhang", "PFYH", "600000"]) {
      const rows = await rowsFor(provider, query);
      expect(rows.map((row) => row.label)).toEqual(["浦发银行", "浦发银行 · 加入自选", "浦发银行 · 加入组合"]);
      expect(rows.map((row) => row.id)).toEqual(["ashare-search:600000.SH", "ashare-search:600000.SH:watchlist", "ashare-search:600000.SH:portfolio"]);
    }
    expect(f.writes).toEqual([]); expect(f.reads).toEqual([]); expect(f.pins).toEqual([]); expect(f.opened).toEqual([]);
  } finally { provider.dispose(); }
});

test("successful empty search is distinct from failure and offers no selectable action", async () => {
  const f = fixture(); let calls = 0, identityCalls = 0;
  const provider = createResearchSearchProvider(f.ctx, {
    searchLoad: async (query) => { calls++; return search(query, []); },
    identityLoad: async () => { identityCalls++; return identity(); },
  });
  try {
    const rows = await rowsFor(provider, "无匹配测试");
    expect(rows.map(({ execute, ...row }) => row)).toEqual([{
      id: "ashare-search:empty", label: "未找到匹配的沪深股票", detail: "试试完整公司简称或六位代码。", disabled: true,
      lines: [{ segments: [{ text: "试试完整公司简称或六位代码。", emphasis: "muted" }] }],
    }]);
    await rows[0]!.execute();
    expect(calls).toBe(1); expect(identityCalls).toBe(0); expect(f.logs).toEqual([]);
    expect(f.reads).toEqual([]); expect(f.writes).toEqual([]); expect(f.pins).toEqual([]); expect(f.opened).toEqual([]);
  } finally { provider.dispose(); }
});

test("source failure returns a disabled safe message without error details or selection side effects", async () => {
  const f = fixture(); let calls = 0, identityCalls = 0;
  const privateError = "fixture-provider failed at /private/fixture/secret.json";
  const provider = createResearchSearchProvider(f.ctx, {
    searchLoad: async () => { calls++; throw new Error(privateError); },
    identityLoad: async () => { identityCalls++; return identity(); },
  });
  try {
    const rows = await rowsFor(provider);
    expect(rows.map(({ execute, ...row }) => row)).toEqual([{
      id: "ashare-search:unavailable", label: "沪深股票搜索暂不可用", detail: "请稍后重试。", disabled: true,
      lines: [{ segments: [{ text: "请稍后重试。", emphasis: "muted" }] }],
    }]);
    expect(JSON.stringify(rows)).not.toContain(privateError); expect(f.logs.join(" ")).not.toContain(privateError);
    await rows[0]!.execute();
    expect(calls).toBe(1); expect(identityCalls).toBe(0); expect(f.notices).toEqual([]);
    expect(f.reads).toEqual([]); expect(f.writes).toEqual([]); expect(f.pins).toEqual([]); expect(f.opened).toEqual([]);
  } finally { provider.dispose(); }
});

test("truncation adds one disabled trailing hint while candidates, ordering and native handoff remain intact", async () => {
  const candidates = [candidate("601916", "浙商银行", "fixture-zsb"), candidate("600036", "招商银行", "fixture-cmb")];
  const f = fixture(), requested: string[] = []; let truncated = false, calls = 0;
  const provider = createResearchSearchProvider(f.ctx, {
    searchLoad: async (query) => {
      calls++; const result = search(query, candidates);
      if (truncated) result.data.totalMatches = 14;
      return result;
    },
    identityLoad: async (symbol) => { requested.push(symbol); return identity(candidates.find((item) => item.symbol === symbol)!); },
  });
  try {
    const normal = await rowsFor(provider, "ZSYH"); truncated = true;
    const rows = await rowsFor(provider, "ZSYH");
    expect(rows).toHaveLength(normal.length + 1);
    expect(rows.slice(0, -1).map(({ execute, ...row }) => row)).toEqual(normal.map(({ execute, ...row }) => row));
    expect(rows.filter((row) => !row.disabled).map((row) => row.id)).toEqual([
      "ashare-search:601916.SH", "ashare-search:601916.SH:watchlist", "ashare-search:601916.SH:portfolio",
      "ashare-search:600036.SH", "ashare-search:600036.SH:watchlist", "ashare-search:600036.SH:portfolio",
    ]);
    expect(rows.at(-1)).toMatchObject({ id: "ashare-search:truncated", label: "候选较多，请细化查询",
      detail: "输入更完整的简称、拼音或代码。", disabled: true,
      lines: [{ segments: [{ text: "输入更完整的简称、拼音或代码。", emphasis: "muted" }] }] });
    await rows.at(-1)!.execute();
    expect(calls).toBe(2); expect(requested).toEqual([]); expect(f.writes).toEqual([]); expect(f.opened).toEqual([]);
    await rowFor(rows, "portfolio", "600036.SH").execute(); await tick();
    expect(requested).toEqual(["600036.SH"]); expect(f.opened).toEqual(["AP 600036:XSHG"]);
    expect(f.writes).toEqual([]); expect(f.pins).toEqual([]);
  } finally { provider.dispose(); }
});

test("cancel, disable and dispose suppress late failures rather than showing unavailable", async () => {
  for (const stop of ["cancel", "disable", "dispose"] as const) {
    const f = fixture(), pending = Promise.withResolvers<ReturnType<typeof search>>(), controller = new AbortController();
    const provider = createResearchSearchProvider(f.ctx, { ...loaders, searchLoad: () => pending.promise });
    try {
      const task = provider.provide("PFYH", context, controller.signal);
      if (stop === "cancel") controller.abort();
      if (stop === "disable") f.config.disabledPlugins = ["ashare-local"];
      if (stop === "dispose") provider.dispose();
      pending.reject(new Error("A non-abort source error after stop"));
      expect(await task).toEqual([]); expect(f.logs).toEqual([]); expect(f.notices).toEqual([]);
    } finally { provider.dispose(); }
  }
});

test("cancel and disable suppress late empty and truncated results too", async () => {
  for (const stop of ["cancel", "disable"] as const) for (const outcome of ["empty", "truncated"] as const) {
    const f = fixture(), pending = Promise.withResolvers<ReturnType<typeof search>>(), controller = new AbortController();
    const provider = createResearchSearchProvider(f.ctx, { ...loaders, searchLoad: () => pending.promise });
    try {
      const task = provider.provide("PFYH", context, controller.signal);
      if (stop === "cancel") controller.abort();
      else f.config.disabledPlugins = ["ashare-local"];
      const result = search("PFYH", outcome === "empty" ? [] : [candidate()]);
      if (outcome === "truncated") result.data.totalMatches = 3;
      pending.resolve(result);
      expect(await task).toEqual([]); expect(f.logs).toEqual([]); expect(f.notices).toEqual([]);
    } finally { provider.dispose(); }
  }
});

test("superseded search cannot publish a late failure, empty notice or truncation hint without caller abort", async () => {
  for (const outcome of ["failure", "empty", "truncated"] as const) {
    const f = fixture(), pending = Promise.withResolvers<ReturnType<typeof search>>(); let calls = 0;
    const provider = createResearchSearchProvider(f.ctx, { ...loaders, searchLoad: async (query) => {
      calls++; return query === "OLD" ? pending.promise : search(query);
    } });
    try {
      const old = rowsFor(provider, "OLD"), current = await rowsFor(provider, "PFYH");
      expect(current.map((row) => row.id)).toEqual(["ashare-search:600000.SH", "ashare-search:600000.SH:watchlist", "ashare-search:600000.SH:portfolio"]);
      if (outcome === "failure") pending.reject(new Error("Old source failure"));
      else {
        const result = search("OLD", outcome === "empty" ? [] : [candidate()]);
        if (outcome === "truncated") result.data.totalMatches = 3;
        pending.resolve(result);
      }
      expect(await old).toEqual([]); expect(calls).toBe(2); expect(f.logs).toEqual([]); expect(f.notices).toEqual([]);
    } finally { provider.dispose(); }
  }
});

test("default candidate continues to open the original research pane with verified current identity", async () => {
  const f = fixture(), provider = createResearchSearchProvider(f.ctx, { ...loaders, identityLoad: async () => identity(candidate(), "当前简称测试") });
  try {
    await rowFor(await rowsFor(provider), "research").execute();
    expect(f.pins).toEqual([{ key: "600000:XSHG", options: { floating: true, paneType: "ticker-research", instrument: null,
      listing: { name: "当前简称测试", exchange: "SSE", currency: "CNY", type: "STK" }, tabId: "overview" } }]);
    const saved = f.stored.get("600000:XSHG")!;
    expect(saved.metadata.portfolios).toEqual([]); expect(saved.metadata.watchlists).toEqual([]); expect(saved.metadata.positions).toEqual([]);
    expect(saved.metadata.custom.ashareChineseIdentity).toMatchObject({ symbol: "600000.SH", name: "当前简称测试", orgId: "fixture-pfyh" });
    expect(f.opened).toEqual([]);
  } finally { provider.dispose(); }
});

test("AW and AP are prefills after the host closes search and never save membership or a position", async () => {
  for (const action of ["watchlist", "portfolio"] as const) {
    const f = fixture([ticker()]), provider = createResearchSearchProvider(f.ctx, loaders);
    try {
      await rowFor(await rowsFor(provider), action).execute();
      expect(f.opened).toEqual([]);
      // The independent renderer acceptance exercises the actual host wrapper.
      // This unit test asserts the execute contract used by that wrapper.
      f.timeline.push("host:close");
      await tick();
      const query = `${action === "watchlist" ? "AW" : "AP"} 600000:XSHG`;
      expect(f.timeline).toEqual(["host:close", `open:${query}`]);
      expect(f.opened).toEqual([query]); expect(f.writes).toEqual([]); expect(f.reads).toEqual([]);
      expect(f.pins).toEqual([]); expect(f.events).toEqual([]); expect(f.stored.get("600000:XSHG")).toEqual(ticker());
    } finally { provider.dispose(); }
  }
});

test("actions require actual watchlists and manual portfolios rather than broker-managed portfolios", async () => {
  const f = fixture(), provider = createResearchSearchProvider(f.ctx, loaders);
  try {
    f.config.watchlists = []; f.config.portfolios[0]!.brokerId = "broker";
    expect((await rowsFor(provider)).map((row) => row.id)).toEqual(["ashare-search:600000.SH"]);
    delete f.config.portfolios[0]!.brokerId; f.config.portfolios[0]!.brokerInstanceId = "connection";
    expect((await rowsFor(provider)).map((row) => row.id)).toEqual(["ashare-search:600000.SH"]);
    delete f.config.portfolios[0]!.brokerInstanceId;
    expect((await rowsFor(provider)).map((row) => row.id)).toEqual(["ashare-search:600000.SH", "ashare-search:600000.SH:portfolio"]);
    const rows = await rowsFor(provider); f.config.portfolios = [];
    await rowFor(rows, "portfolio").execute(); await tick();
    expect(f.opened).toEqual([]); expect(f.writes).toEqual([]);
  } finally { provider.dispose(); }
});

test("initials collisions keep explicit choices and only the selected company reaches AW", async () => {
  const candidates = [candidate("600036", "招商银行", "fixture-cmb"), candidate("601916", "浙商银行", "fixture-zsb")];
  const f = fixture(), requested: string[] = [], provider = createResearchSearchProvider(f.ctx, {
    searchLoad: async (query) => search(query, candidates), identityLoad: async (symbol) => {
      requested.push(symbol); return identity(candidates.find((item) => item.symbol === symbol)!);
    } });
  try {
    const rows = await rowsFor(provider, "ZSYH"); expect(rows).toHaveLength(6);
    expect(requested).toEqual([]); expect(f.opened).toEqual([]);
    await rowFor(rows, "watchlist", "601916.SH").execute(); await tick();
    expect(requested).toEqual(["601916.SH"]); expect(f.opened).toEqual(["AW 601916:XSHG"]); expect(f.writes).toEqual([]);
  } finally { provider.dispose(); }
});

test("collection handoff leaves distinct bare and MIC records intact for the host to resolve", async () => {
  const bare = ticker("600000", "bare owner"), mic = ticker("600000:XSHG", "MIC owner");
  mic.metadata.positions = []; mic.metadata.portfolios = []; mic.metadata.watchlists = [];
  const f = fixture([bare, mic]), provider = createResearchSearchProvider(f.ctx, loaders);
  try {
    const rows = await rowsFor(provider);
    await rowFor(rows, "watchlist").execute(); await tick();
    await rowFor(rows, "portfolio").execute(); await tick();
    expect(Array.from(f.stored.values())).toEqual([bare, mic]);
    expect(f.writes).toEqual([]); expect(f.reads).toEqual([]);
    expect(f.opened).toEqual(["AW 600000:XSHG", "AP 600000:XSHG"]);
  } finally { provider.dispose(); }
});

test("a newer selected candidate cancels an older scheduled handoff", async () => {
  const next = candidate("300059", "东方财富", "fixture-dfcf"), f = fixture(), provider = createResearchSearchProvider(f.ctx, {
    searchLoad: async (query) => search(query, query === "DFCF" ? [next] : [candidate()]),
    identityLoad: async (symbol) => identity(symbol === next.symbol ? next : candidate()),
  });
  try {
    const first = await rowsFor(provider), second = await rowsFor(provider, "DFCF");
    await rowFor(first, "watchlist").execute();
    await rowFor(second, "portfolio", next.symbol).execute(); await tick();
    expect(f.opened).toEqual(["AP 300059:XSHE"]); expect(f.writes).toEqual([]);
  } finally { provider.dispose(); }
});

test("a late older issuer response cannot save, pin or replace a newer selection", async () => {
  const next = candidate("300059", "东方财富", "fixture-dfcf"), pending = Promise.withResolvers<BridgeResult<ResearchIdentityData>>();
  const f = fixture(), signals: (AbortSignal | undefined)[] = [], provider = createResearchSearchProvider(f.ctx, {
    searchLoad: async (query) => search(query, query === "DFCF" ? [next] : [candidate()]),
    identityLoad: async (symbol, signal) => { signals.push(signal); return symbol === next.symbol ? identity(next) : pending.promise; },
  });
  try {
    const first = await rowsFor(provider), second = await rowsFor(provider, "DFCF");
    const old = rowFor(first, "research").execute(); await Promise.resolve();
    await rowFor(second, "portfolio", next.symbol).execute();
    pending.resolve(identity()); await old; await tick();
    expect(signals[0]?.aborted).toBe(true); expect(f.opened).toEqual(["AP 300059:XSHE"]);
    expect(f.writes).toEqual([]); expect(f.pins).toEqual([]); expect(f.notices).toEqual([]);
  } finally { provider.dispose(); }
});

test("dispose cancels scheduled handoff and makes already cached rows inert", async () => {
  const f = fixture(), provider = createResearchSearchProvider(f.ctx, loaders), rows = await rowsFor(provider);
  await rowFor(rows, "watchlist").execute(); provider.dispose(); provider.dispose(); await tick();
  await rowFor(rows, "research").execute(); await rowFor(rows, "portfolio").execute(); await tick();
  expect(await rowsFor(provider)).toEqual([]); expect(f.opened).toEqual([]); expect(f.writes).toEqual([]); expect(f.pins).toEqual([]);
});

test("dispose aborts pending search and discards a loader that returns after unload", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof search>>(), f = fixture();
  let seenSignal: AbortSignal | undefined, calls = 0;
  const provider = createResearchSearchProvider(f.ctx, { ...loaders, searchLoad: async (_query, signal) => {
    calls++; seenSignal = signal; return pending.promise;
  } });
  const task = rowsFor(provider); await Promise.resolve(); provider.dispose(); pending.resolve(search("PFYH"));
  expect(await task).toEqual([]); expect(seenSignal?.aborted).toBe(true); expect(await rowsFor(provider)).toEqual([]);
  expect(calls).toBe(1); expect(f.logs).toEqual([]);
});

test("unload during exact identity lookup suppresses every selected action", async () => {
  for (const action of ["research", "watchlist", "portfolio"] as const) {
    const pending = Promise.withResolvers<ReturnType<typeof identity>>(), f = fixture();
    let signalSeen: AbortSignal | undefined;
    const provider = createResearchSearchProvider(f.ctx, { ...loaders, identityLoad: async (_symbol, signal) => {
      signalSeen = signal; return pending.promise;
    } });
    const task = rowFor(await rowsFor(provider), action).execute(); await Promise.resolve();
    provider.dispose(); pending.resolve(identity()); await task; await tick();
    expect(signalSeen?.aborted).toBe(true); expect(f.writes).toEqual([]); expect(f.pins).toEqual([]); expect(f.opened).toEqual([]); expect(f.notices).toEqual([]);
  }
});

test("disabled config stops late identity, late search and pending handoff", async () => {
  const f = fixture(), identityPending = Promise.withResolvers<ReturnType<typeof identity>>();
  const provider = createResearchSearchProvider(f.ctx, { ...loaders, identityLoad: () => identityPending.promise });
  try {
    const rows = await rowsFor(provider), task = rowFor(rows, "research").execute(); await Promise.resolve();
    f.config.disabledPlugins = ["ashare-local"]; identityPending.resolve(identity()); await task;
    expect(f.writes).toEqual([]); expect(f.pins).toEqual([]); expect(f.notices).toEqual([]); expect(await rowsFor(provider)).toEqual([]);
  } finally { provider.dispose(); }
  const next = fixture(), nextProvider = createResearchSearchProvider(next.ctx, loaders);
  try {
    await rowFor(await rowsFor(nextProvider), "watchlist").execute(); next.config.disabledPlugins = ["ashare-local"]; await tick();
    expect(next.opened).toEqual([]);
  } finally { nextProvider.dispose(); }
  const late = fixture(), searchPending = Promise.withResolvers<ReturnType<typeof search>>();
  const lateProvider = createResearchSearchProvider(late.ctx, { ...loaders, searchLoad: () => searchPending.promise });
  try {
    const task = rowsFor(lateProvider); late.config.disabledPlugins = ["ashare-local"]; searchPending.resolve(search("PFYH"));
    expect(await task).toEqual([]); expect(late.logs).toEqual([]);
  } finally { lateProvider.dispose(); }
});

test("collection removal before the deferred task prevents reopening an unusable command", async () => {
  for (const action of ["watchlist", "portfolio"] as const) {
    const f = fixture(), provider = createResearchSearchProvider(f.ctx, loaders);
    try {
      await rowFor(await rowsFor(provider), action).execute();
      if (action === "watchlist") f.config.watchlists = []; else f.config.portfolios = [];
      await tick(); expect(f.opened).toEqual([]); expect(f.writes).toEqual([]);
    } finally { provider.dispose(); }
  }
});

test("wrong code, venue, issuer, category, delisting or source rejects research and native handoff", async () => {
  const mutations: ((raw: ReturnType<typeof identity>) => void)[] = [
    (raw) => { raw.data.symbol = "600001.SH"; }, (raw) => { raw.data.code = "600001"; },
    (raw) => { raw.data.exchange = "SZSE"; },
    (raw) => { raw.data.orgId = "changed-issuer"; raw.data.officialIdentity.orgId = "changed-issuer"; },
    (raw) => { raw.data.officialIdentity.category = "基金" as "A股"; },
    (raw) => { raw.data.officialIdentity.delisted = "true" as "false"; },
    (raw) => { raw.data.source.sourceURL = "https://example.com/wrong"; },
  ];
  for (const action of ["research", "watchlist", "portfolio"] as const) for (const mutate of mutations) {
    const f = fixture(), raw = identity(); mutate(raw);
    const provider = createResearchSearchProvider(f.ctx, { ...loaders, identityLoad: async () => raw });
    try {
      await rowFor(await rowsFor(provider), action).execute(); await tick();
      expect(f.writes).toEqual([]); expect(f.pins).toEqual([]); expect(f.opened).toEqual([]); expect(f.notices).toHaveLength(1);
    } finally { provider.dispose(); }
  }
});

test("the latest name, position, membership and notes survive default research identity annotation", async () => {
  const original = ticker(), f = fixture([original]), provider = createResearchSearchProvider(f.ctx, loaders);
  f.setLoadHook((_key, count) => {
    if (count !== 1) return;
    const latest = f.stored.get("600000:XSHG")!;
    latest.metadata.name = "用户刚修改的名字"; latest.metadata.positions[0]!.shares = 99;
    latest.metadata.watchlists = ["latest-list"]; latest.metadata.portfolios = ["latest-portfolio"];
    latest.metadata.custom.note = "latest note"; latest.metadata.tags.push("latest tag");
  });
  try {
    await rowFor(await rowsFor(provider), "research").execute();
    const saved = f.stored.get("600000:XSHG")!;
    expect(saved.metadata.name).toBe("用户刚修改的名字"); expect(saved.metadata.positions[0]?.shares).toBe(99);
    expect(saved.metadata.positions[0]?.avgCost).toBe(0); expect(saved.metadata.watchlists).toEqual(["latest-list"]);
    expect(saved.metadata.portfolios).toEqual(["latest-portfolio"]); expect(saved.metadata.custom.note).toBe("latest note");
    expect(saved.metadata.tags).toEqual(["saved", "latest tag"]);
    expect(f.pins[0]?.options).toMatchObject({ listing: { name: "浦发银行" } }); expect(f.opened).toEqual([]);
  } finally { provider.dispose(); }
});

test("existing currency, venue, derivative and issuer conflicts never change a saved research record", async () => {
  for (const changes of [{ currency: "USD" }, { exchange: "XSHE" }, { assetCategory: "ETF" },
    { custom: { ashareChineseIdentity: { symbol: "600000.SH", orgId: "other-issuer" } } }]) {
    const original = ticker(); Object.assign(original.metadata, changes);
    const f = fixture([original]), provider = createResearchSearchProvider(f.ctx, loaders);
    try {
      await rowFor(await rowsFor(provider), "research").execute();
      expect(f.stored.get("600000:XSHG")).toEqual(original); expect(f.writes).toEqual([]); expect(f.pins).toEqual([]); expect(f.notices).toHaveLength(1);
    } finally { provider.dispose(); }
  }
});

test("an identity conflict introduced between repository reads blocks default research saving", async () => {
  const f = fixture([ticker()]), provider = createResearchSearchProvider(f.ctx, loaders);
  f.setLoadHook((_key, count) => { if (count === 1) f.stored.get("600000:XSHG")!.metadata.currency = "USD"; });
  try {
    await rowFor(await rowsFor(provider), "research").execute();
    expect(f.stored.get("600000:XSHG")!.metadata.currency).toBe("USD"); expect(f.writes).toEqual([]); expect(f.pins).toEqual([]); expect(f.notices).toHaveLength(1);
  } finally { provider.dispose(); }
});

test("invalid queries and aborted searches stay silent while invalid directory data reports unavailable", async () => {
  const f = fixture(); let calls = 0;
  const provider = createResearchSearchProvider(f.ctx, { ...loaders, searchLoad: async (query) => { calls++; return search(query); } });
  try {
    for (const query of ["", " ", "a".repeat(65), "PF\u200bYH", "PF\u0000YH"]) expect(await rowsFor(provider, query)).toEqual([]);
    const aborted = new AbortController(); aborted.abort(); expect(await provider.provide("PFYH", context, aborted.signal)).toEqual([]); expect(calls).toBe(0);
  } finally { provider.dispose(); }
  const invalid = fixture(), raw = search("PFYH"); raw.data.candidates[0]!.exchange = "SZSE";
  const invalidProvider = createResearchSearchProvider(invalid.ctx, { ...loaders, searchLoad: async () => raw });
  try {
    const rows = await rowsFor(invalidProvider);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: "ashare-search:unavailable", disabled: true });
    expect(invalid.writes).toEqual([]); expect(invalid.pins).toEqual([]); expect(invalid.opened).toEqual([]);
  }
  finally { invalidProvider.dispose(); }
  const late = fixture(), pending = Promise.withResolvers<ReturnType<typeof search>>(), controller = new AbortController();
  const lateProvider = createResearchSearchProvider(late.ctx, { ...loaders, searchLoad: () => pending.promise });
  try {
    const task = lateProvider.provide("PFYH", context, controller.signal); controller.abort(); pending.resolve(search("PFYH"));
    expect(await task).toEqual([]); expect(late.logs).toEqual([]);
  } finally { lateProvider.dispose(); }
});
