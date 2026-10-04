import { expect, test } from "bun:test";
import { createDefaultConfig } from "gloomberb/types/config";
import type { TickerRecord } from "gloomberb/types/ticker";
import { NATIVE_NAME_PROVENANCE_KEY, formatNativeName, type NativeNameProvenanceV1, type NativeNameProvenanceV2 } from "./native-list-names";
import { mergeNativeName, nativeNamePublication, type NativeNamePublication } from "./native-name-publication";

const chineseName = "腾远钴业", englishName = "Ganzhou Tengyuan Cobalt Co., Ltd.";
const time = "2026-10-04T09:00:00Z";
const source = { provider: "cninfo" as const, sourceURL: "https://www.cninfo.com.cn/new/information/topSearch/query?keyWord=301219&maxNum=10",
  receivedAt: time, sha256: "a".repeat(64), sourceVersion: null };
const evidence = { providerId: "gloomberb-cloud", symbol: "301219", exchange: "SZSE", currency: "CNY", name: englishName,
  instrumentType: "EQUITY", observedAt: time };
function legacy(): NativeNameProvenanceV1 {
  return { schemaVersion: 1, managedBy: "ashare-local", symbol: "301219.SZ", code: "301219", exchange: "SZSE", orgId: "fixture-issuer",
    previousName: englishName, appliedName: chineseName, appliedAt: time, ownershipBasis: "cloud_search", providerEvidence: evidence, source };
}
function publication(mode: "bilingual" | "chinese" | "english" = "bilingual", hasEnglish = true): NativeNamePublication {
  const name = formatNativeName(chineseName, hasEnglish ? englishName : null, mode);
  const provenance: NativeNameProvenanceV2 = { ...legacy(), schemaVersion: 2, chineseName, englishName: hasEnglish ? englishName : null,
    englishNameEvidence: hasEnglish ? evidence : null, displayMode: mode, appliedName: name };
  return { symbol: "301219", name, provenance };
}
function config(mode: "bilingual" | "chinese" | "english" = "bilingual") {
  const value = createDefaultConfig(new URL("./publication-memory-profile", import.meta.url).pathname);
  value.portfolios = [{ id: "main", name: "Main Portfolio", currency: "CNY" }]; value.watchlists = [{ id: "watch", name: "Watchlist" }];
  value.pluginConfig["ashare-local"] = { nameDisplay: mode };
  return value;
}
function current(): TickerRecord {
  return { metadata: { ticker: "301219", name: chineseName, currency: "CNY", exchange: "SZSE", assetCategory: "Common Stock",
    portfolios: ["main"], watchlists: ["watch"], positions: [{ portfolio: "main", shares: 123, avgCost: 4, broker: "manual" }],
    broker_contracts: [], tags: ["current"], custom: { unrelated: { current: true }, [NATIVE_NAME_PROVENANCE_KEY]: legacy() } } };
}
function fault(change: (publication: NativeNamePublication) => void): NativeNamePublication {
  const value = structuredClone(publication()); change(value); return value;
}

test("a legacy Chinese renderer record migrates to bilingual without replaying saved positions or custom edits", () => {
  const record = current(); record.metadata.positions[0]!.shares = 789; record.metadata.custom.unrelated = { current: "edited" };
  const updated = mergeNativeName(record, publication(), config())!;
  expect(updated.metadata.name).toBe(`${chineseName} · ${englishName}`);
  expect(updated.metadata.positions).toBe(record.metadata.positions);
  expect(updated.metadata.portfolios).toBe(record.metadata.portfolios);
  expect(updated.metadata.watchlists).toBe(record.metadata.watchlists);
  expect(updated.metadata.tags).toBe(record.metadata.tags);
  expect(updated.metadata.custom.unrelated).toEqual({ current: "edited" });
  expect(updated.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ schemaVersion: 2, previousName: englishName, appliedName: updated.metadata.name });
  expect(record.metadata.name).toBe(chineseName);
});

test("Chinese mode still upgrades legacy provenance when the visible name stays the same", () => {
  const record = current(), value = publication("chinese"), updated = mergeNativeName(record, value, config("chinese"));
  expect(updated).not.toBeNull(); expect(updated!.metadata.name).toBe(chineseName);
  expect(updated!.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ schemaVersion: 2, displayMode: "chinese", englishName });
  expect(updated!.metadata.positions).toBe(record.metadata.positions);
});

test("current user names and a prior provenance that no longer owns the current name cannot be overwritten", () => {
  const custom = current(); custom.metadata.name = "我的持仓标签";
  expect(mergeNativeName(custom, publication(), config())).toBeNull();
  const stale = current(); (stale.metadata.custom[NATIVE_NAME_PROVENANCE_KEY] as NativeNameProvenanceV1).appliedName = "旧简称";
  expect(mergeNativeName(stale, publication(), config())).toBeNull();
  const issuer = current(); (issuer.metadata.custom[NATIVE_NAME_PROVENANCE_KEY] as NativeNameProvenanceV1).orgId = "another-issuer";
  expect(mergeNativeName(issuer, publication(), config())).toBeNull();
  issuer.metadata.name = englishName;
  expect(mergeNativeName(issuer, publication(), config())).toBeNull();
  const original = current(); original.metadata.name = englishName; original.metadata.custom = { untouched: true };
  expect(mergeNativeName(original, publication(), config())?.metadata.name).toBe(publication().name);
});

test("a current issuer identity changed while a publication was pending cannot consume the old issuer name", () => {
  const record = current();
  record.metadata.custom.ashareChineseIdentity = { orgId: "fixture-issuer", symbol: "301219:XSHE" };
  expect(mergeNativeName(record, publication(), config())?.metadata.name).toBe(publication().name);
  for (const identity of [{ orgId: "another-issuer", symbol: "301219.SZ" }, { orgId: "fixture-issuer", symbol: "301220.SZ" }]) {
    const changed = structuredClone(record); changed.metadata.custom.ashareChineseIdentity = identity;
    expect(mergeNativeName(changed, publication(), config())).toBeNull();
    expect(changed.metadata.name).toBe(chineseName);
  }
});

test("foreign, mismatched, and nonmember records cannot consume a valid bilingual publication", () => {
  const changes: Array<(record: TickerRecord) => void> = [
    record => { record.metadata.exchange = "SSE"; }, record => { record.metadata.currency = "USD"; },
    record => { record.metadata.assetCategory = "ETF"; }, record => { record.metadata.ticker = "301220"; },
    record => { record.metadata.portfolios = []; record.metadata.watchlists = []; record.metadata.positions = []; },
  ];
  for (const change of changes) { const record = current(); change(record); expect(mergeNativeName(record, publication(), config())).toBeNull(); }
  const disabled = config(); disabled.disabledPlugins = ["ashare-local"];
  expect(mergeNativeName(current(), publication(), disabled)).toBeNull();
});

test("bare, suffix, and MIC ticker keys retain their exact record identity through publication and merging", () => {
  for (const key of ["301219", "301219.SZ", "301219:XSHE"]) {
    const record = current(); record.metadata.ticker = key;
    const value = publication(); value.symbol = key;
    const updated = mergeNativeName(record, value, config())!;
    expect(updated.metadata.ticker).toBe(key);
    expect(nativeNamePublication(updated)?.symbol).toBe(key);
    expect(nativeNamePublication(updated)?.provenance.symbol).toBe("301219.SZ");
    const differentKey = publication(); differentKey.symbol = key === "301219" ? "301219:XSHE" : "301219";
    expect(mergeNativeName(record, differentKey, config())).toBeNull();
  }
});

test("malformed English evidence and inconsistent formatted provenance are rejected at publication and merge boundaries", () => {
  const malformed = [
    fault(value => { (value.provenance as NativeNameProvenanceV2).englishName = "301219"; }),
    fault(value => { (value.provenance as NativeNameProvenanceV2).englishName = chineseName; }),
    fault(value => { (value.provenance as NativeNameProvenanceV2).englishNameEvidence = null; }),
    fault(value => { (value.provenance as NativeNameProvenanceV2).englishNameEvidence = { ...evidence, symbol: "301220" }; }),
    fault(value => { (value.provenance as NativeNameProvenanceV2).englishNameEvidence = { ...evidence, currency: "USD" }; }),
    fault(value => { value.provenance.appliedName = chineseName; }),
    fault(value => { value.name = "不同显示字符串"; }),
    fault(value => { (value.provenance as unknown as Record<string, unknown>).displayMode = "unknown"; }),
  ];
  for (const value of malformed) {
    const record = current(); record.metadata.name = value.name; record.metadata.custom[NATIVE_NAME_PROVENANCE_KEY] = value.provenance;
    expect(nativeNamePublication(record)).toBeNull();
    expect(mergeNativeName(current(), value, config())).toBeNull();
  }
});

test("an English mode publication with no verified English name falls back to Chinese rather than its old code", () => {
  const value = publication("english", false), record = current();
  value.provenance.previousName = "301219"; record.metadata.name = "301219"; record.metadata.custom = {};
  const updated = mergeNativeName(record, value, config("english"))!;
  expect(updated.metadata.name).toBe(chineseName);
  expect(nativeNamePublication(updated)?.name).toBe(chineseName);
});

test("a same-issuer mode transition accepts only the name currently owned by prior appliedName", () => {
  const record = current(), first = mergeNativeName(record, publication(), config())!;
  const english = mergeNativeName(first, publication("english"), config("english"))!;
  expect(english.metadata.name).toBe(englishName);
  expect(english.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ previousName: englishName, displayMode: "english" });
  const chinese = mergeNativeName(english, publication("chinese"), config("chinese"))!;
  expect(chinese.metadata.name).toBe(chineseName);
  expect(mergeNativeName(chinese, publication("chinese"), config("chinese"))).toBeNull();
  const override = structuredClone(english); override.metadata.name = "自己改过的名字";
  expect(mergeNativeName(override, publication("chinese"), config("chinese"))).toBeNull();
});
