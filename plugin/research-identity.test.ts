import { expect, test } from "bun:test";
import { loadResearchIdentity, loadResearchSearch, parseResearchIdentity, parseResearchSearch } from "./research-identity";

const sourceTime = "2026-10-03T16:00:00.000Z";
const returnedTime = "2026-10-03T16:05:00.000Z";
function source(identity = false) {
  return { provider: "cninfo", sourceURL: identity ? "https://www.cninfo.com.cn/new/information/topSearch/query?keyWord=300059&maxNum=10" : "https://www.cninfo.com.cn/new/data/szse_stock.json",
    receivedAt: sourceTime, sha256: "a".repeat(64), sourceVersion: null };
}
function search(query = "DFCF") {
  return { data: { schemaVersion: 1, mode: "cninfo_shsz_search", query, normalizedQuery: query.toLowerCase(), limit: 10, totalMatches: 1,
    candidates: [{ symbol: "300059.SZ", code: "300059", exchange: "SZSE", exchangeBasis: "code_prefix_route", category: "A股", name: "东方财富", orgId: "9900012345",
      officialInitials: "dfcf", fullPinyin: "dongfangcaifu", generatedInitials: "dfcf", matchKind: "initials_exact", identityBasis: "directory_index" }],
    pinyin: { provider: "pypinyin", version: "0.55.0", derived: true }, source: source(), limitations: ["目录候选不等于当前上市身份认证。"] },
    meta: { mode: "cninfo_shsz_search", receivedAt: sourceTime, returnedAt: returnedTime, fromCache: true } };
}
function identity() {
  return { data: { schemaVersion: 1, mode: "cninfo_shsz_identity", symbol: "300059.SZ", code: "300059", exchange: "SZSE", exchangeBasis: "code_prefix_route",
    identityBasis: "official_exact_current_code", name: "东方财富", orgId: "9900012345", officialIdentity: { code: "300059", category: "A股", type: "shj", delisted: "false", orgId: "9900012345", zwjc: "东方财富", pinyin: "dfcf" }, source: source(true) },
    meta: { mode: "cninfo_shsz_identity", receivedAt: sourceTime, returnedAt: returnedTime, fromCache: true } };
}

test("search retains candidate scope, derived pinyin and original source clock through a cached delivery", () => {
  const raw = search(), result = parseResearchSearch("DFCF", raw);
  expect(result.data.candidates[0]?.symbol).toBe("300059.SZ");
  expect(result.data.candidates[0]?.name).toBe("东方财富");
  expect(result.data.candidates[0]?.identityBasis).toBe("directory_index");
  expect(result.data.candidates[0]?.exchangeBasis).toBe("code_prefix_route");
  expect(result.data.source.receivedAt).toBe(sourceTime);
  expect(result.meta.returnedAt).toBe(returnedTime);
  expect(result.data.pinyin.derived).toBeTrue();
  raw.data.candidates[0]!.name = "mutated";
  expect(result.data.candidates[0]?.name).toBe("东方财富");
  const missingDerived = search(); Object.assign(missingDerived.data.candidates[0]!, { fullPinyin: null, generatedInitials: null });
  expect(parseResearchSearch("DFCF", missingDerived).data.candidates[0]?.fullPinyin).toBeNull();
});

test("ambiguous initials preserve every candidate instead of selecting the first", () => {
  const raw = search("ZSYH");
  raw.data.candidates = [
    { ...raw.data.candidates[0]!, symbol: "600036.SH", code: "600036", exchange: "SSE", name: "招商银行", fullPinyin: "zhaoshangyinhang", officialInitials: "zsyh", generatedInitials: "zsyh" },
    { ...raw.data.candidates[0]!, symbol: "601916.SH", code: "601916", exchange: "SSE", name: "浙商银行", fullPinyin: "zheshangyinhang", officialInitials: "zsyh", generatedInitials: "zsyh" },
  ]; raw.data.totalMatches = 2;
  const result = parseResearchSearch("ZSYH", raw);
  expect(result.data.candidates.map((item) => item.symbol)).toEqual(["600036.SH", "601916.SH"]);
});

test("search rejects wrong query, foreign/current-code conflicts, duplicates, unsupported match kinds and false source evidence", () => {
  const mismatch = search(); expect(() => parseResearchSearch("DFCFX", mismatch)).toThrow("查询");
  for (const changes of [{ symbol: "300059.SH" }, { code: "600519" }, { exchange: "SSE" }, { symbol: "920185.BJ", code: "920185", exchange: "BJSE" },
    { category: "基金" }, { identityBasis: "official_exact_current_code" }, { exchangeBasis: "official_exchange" }, { matchKind: "first_result" }, { fullPinyin: "中文" }, { orgId: "bad id" }]) {
    const raw = search(); Object.assign(raw.data.candidates[0]!, changes); expect(() => parseResearchSearch("DFCF", raw)).toThrow();
  }
  const duplicate = search(); duplicate.data.candidates.push({ ...duplicate.data.candidates[0]! }); duplicate.data.totalMatches = 2;
  expect(() => parseResearchSearch("DFCF", duplicate)).toThrow("重复");
  for (const url of ["https://example.com/new/data/szse_stock.json", "https://www.cninfo.com.cn/new/other", "https://www.cninfo.com.cn/new/data/szse_stock.json?x=1",
    "https://user@www.cninfo.com.cn/new/data/szse_stock.json", "https://www.cninfo.com.cn/new/data/szse_stock.json#fake"]) {
    const raw = search(); raw.data.source.sourceURL = url; expect(() => parseResearchSearch("DFCF", raw)).toThrow("来源");
  }
  const timing = search(); timing.meta.receivedAt = returnedTime; expect(() => parseResearchSearch("DFCF", timing)).toThrow("时间");
});

test("exact lookup proves current A-share code/name/orgId while keeping venue as declared prefix routing", () => {
  const raw = identity(), result = parseResearchIdentity("300059", raw);
  expect(result.data.name).toBe("东方财富");
  expect(result.data.identityBasis).toBe("official_exact_current_code");
  expect(result.data.exchangeBasis).toBe("code_prefix_route");
  expect(result.data.officialIdentity.type).toBe("shj");
  expect(result.data.officialIdentity.pinyin).toBe("dfcf");
  expect(result.data.source.receivedAt).toBe(sourceTime);
  expect(result.meta.returnedAt).toBe(returnedTime);
  raw.data.officialIdentity.zwjc = "mutated";
  expect(result.data.officialIdentity.zwjc).toBe("东方财富");
});

test("identity rejects a different company, delisting, category or name/code disagreement without making venue claims from shj", () => {
  for (const changes of [{ code: "600519" }, { category: "B股" }, { delisted: "true" }, { type: "sz" }, { orgId: "different" }, { zwjc: "不同公司" }]) {
    const raw = identity(); Object.assign(raw.data.officialIdentity, changes); expect(() => parseResearchIdentity("300059", raw)).toThrow("身份");
  }
  const different = identity(); expect(() => parseResearchIdentity("002594", different)).toThrow("代码");
  const route = identity(); route.data.exchange = "SSE"; expect(() => parseResearchIdentity("300059", route)).toThrow();
  const url = identity(); url.data.source.sourceURL = "https://www.cninfo.com.cn/new/information/topSearch/query?keyWord=600519&maxNum=10";
  expect(() => parseResearchIdentity("300059", url)).toThrow("来源请求");
  const date = identity(); date.data.source.receivedAt = "2026-10-03T16:00:00"; expect(() => parseResearchIdentity("300059", date)).toThrow("offset");
});

test("query loading preserves all four request modes and canonical lookup without changing market-data APIs", async () => {
  const calls: unknown[][] = [];
  const client = { async request(path: string, params: Record<string, string>, signal?: AbortSignal) {
    calls.push([path, params, signal]); return path === "/v1/research-identity" ? identity() : search(params.q);
  } };
  for (const query of ["东方财富", "300059", "DONGFANGCAIFU", "DFCF"]) {
    const result = await loadResearchSearch(query, undefined, { client }); expect(result.data.query).toBe(query);
  }
  const controller = new AbortController();
  expect((await loadResearchIdentity("300059:XSHE", controller.signal, { client })).data.symbol).toBe("300059.SZ");
  expect(calls[4]).toEqual(["/v1/research-identity", { symbol: "300059.SZ" }, controller.signal]);
  expect(calls.slice(0, 4).map((call) => call[1])).toEqual(["东方财富", "300059", "DONGFANGCAIFU", "DFCF"].map((q) => ({ q, limit: "10" })));
});

test("empty/invalid queries and cancelled lookups do not fetch, and late cancelled replies are discarded", async () => {
  let calls = 0; const pending = Promise.withResolvers<ReturnType<typeof identity>>();
  const client = { request: () => { calls++; return pending.promise; } };
  for (const query of ["", " ", "a".repeat(65), "a\n", "df\u200bcf"]) await expect(loadResearchSearch(query, undefined, { client })).rejects.toThrow();
  for (const symbol of ["300059.SH", "920185", "835185.BJ"]) await expect(loadResearchIdentity(symbol, undefined, { client })).rejects.toThrow();
  const pre = new AbortController(); pre.abort(); await expect(loadResearchIdentity("300059", pre.signal, { client })).rejects.toThrow("abort");
  expect(calls).toBe(0);
  const controller = new AbortController(); const result = loadResearchIdentity("300059", controller.signal, { client });
  controller.abort(); pending.resolve(identity()); await expect(result).rejects.toThrow("abort"); expect(calls).toBe(1);
});
