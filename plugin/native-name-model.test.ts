import { expect, test } from "bun:test";
import type { Quote } from "gloomberb/types/financials";
import type { InstrumentSearchResult } from "gloomberb/types/instrument";
import { formatNativeName, nativeQuoteEnglishEvidence, nativeSearchEnglishEvidence, parseNativeNameProvenance,
  resolveNativeNameDisplayMode, type NativeNameProvenanceV1, type NativeNameProvenanceV2 } from "./native-name-model";
import { resolveResearchListing } from "./research-symbols";

const time = "2026-10-04T04:00:00.000Z", listing = resolveResearchListing("301219.SZ", "SZSE")!;
const english = "Ganzhou Tengyuan Cobalt Co., Ltd.";
function row(overrides: Partial<InstrumentSearchResult> = {}): InstrumentSearchResult {
  return { providerId: "gloomberb-cloud", symbol: "301219", exchange: "SZSE", currency: "CNY", type: "Common Stock", name: english, ...overrides };
}
function legacy(): NativeNameProvenanceV1 {
  return { schemaVersion: 1, managedBy: "ashare-local", symbol: listing.symbol, code: listing.code, exchange: "SZSE", orgId: "9900035080",
    previousName: english, appliedName: "腾远钴业", appliedAt: time, ownershipBasis: "cloud_search",
    providerEvidence: { providerId: "gloomberb-cloud", symbol: "301219", exchange: "SZSE", currency: "CNY", name: english },
    source: { provider: "cninfo", sourceURL: "https://www.cninfo.com.cn/new/information/topSearch/query?keyWord=301219&maxNum=10",
      receivedAt: time, sha256: "a".repeat(64), sourceVersion: null } };
}
function bilingual(): NativeNameProvenanceV2 {
  return { ...legacy(), schemaVersion: 2, chineseName: "腾远钴业", englishName: english, englishNameEvidence: nativeSearchEnglishEvidence([row()], listing, time),
    displayMode: "bilingual", appliedName: formatNativeName("腾远钴业", english, "bilingual") };
}

test("native names default to bilingual and all modes fall back to sourced Chinese", () => {
  expect(resolveNativeNameDisplayMode({})).toBe("bilingual");
  expect(resolveNativeNameDisplayMode({ pluginConfig: { "ashare-local": { nameDisplay: "invalid" } } })).toBe("bilingual");
  for (const mode of ["bilingual", "chinese", "english"] as const) {
    expect(resolveNativeNameDisplayMode({ pluginConfig: { "ashare-local": { nameDisplay: mode } } })).toBe(mode);
    expect(formatNativeName("腾远钴业", null, mode)).toBe("腾远钴业");
  }
  expect(formatNativeName("腾远钴业", english, "bilingual")).toBe(`腾远钴业 · ${english}`);
  expect(formatNativeName("腾远钴业", english, "chinese")).toBe("腾远钴业");
  expect(formatNativeName("腾远钴业", english, "english")).toBe(english);
});

test("English evidence binds native Cloud or Yahoo to exact venue, CNY and ordinary equity", () => {
  for (const providerId of ["gloomberb-cloud", "yahoo", "yahoo-finance"]) {
    expect(nativeSearchEnglishEvidence([row({ providerId, symbol: "301219.SZ", exchange: "XSHE" })], listing, time))
      .toMatchObject({ providerId, name: english, instrumentType: "Common Stock", observedAt: time });
  }
  for (const invalid of [{ symbol: "301218" }, { exchange: "SSE" }, { exchange: "" }, { currency: "USD" },
    { currency: undefined }, { type: "ETF" }, { type: "" }, { providerId: "broker" }, { name: "腾远钴业" },
    { name: "301219.SZ" }, { name: "301219.XSHE" }, { name: "301219 (SZSE)" }, { name: "301219" }, { name: `${english}\u0000` }, { name: `\t${english}` },
    { name: `${english}\u202e` }, { brokerContract: {} as never }]) {
    expect(nativeSearchEnglishEvidence([row(invalid)], listing, time)).toBeNull();
  }
  expect(nativeSearchEnglishEvidence([row(), row({ providerId: "yahoo", name: "Another Exact Listing Name" })], listing, time)).toBeNull();
  expect(nativeSearchEnglishEvidence([row(), row({ providerId: "yahoo" })], listing, time)?.name).toBe(english);
});

test("native quote English is independent of saved labels but requires a reported stock type", () => {
  const quote = { symbol: "301219.SZ", listingExchangeName: "XSHE", currency: "CNY", instrumentType: "EQUITY", name: english,
    providerId: "yahoo", price: 100, change: 0, changePercent: 0, lastUpdated: 0 } as Quote;
  expect(nativeQuoteEnglishEvidence(quote, listing, time)).toMatchObject({ providerId: "yahoo", name: english, observedAt: time });
  for (const invalid of [{ symbol: "301218.SZ" }, { listingExchangeName: "XSHG" }, { currency: "USD" },
    { instrumentType: undefined }, { instrumentType: "ETF" }, { name: "腾远钴业" }, { providerId: "untrusted" }]) {
    expect(nativeQuoteEnglishEvidence({ ...quote, ...invalid }, listing, time)).toBeNull();
  }
});

test("provenance accepts the v1 migration bridge and coherent v2 names, without promoting historical previousName", () => {
  expect(parseNativeNameProvenance(legacy())?.schemaVersion).toBe(1);
  expect(parseNativeNameProvenance(bilingual())?.schemaVersion).toBe(2);
  const noEnglish = { ...bilingual(), englishName: null, englishNameEvidence: null, appliedName: "腾远钴业" };
  expect(parseNativeNameProvenance(noEnglish)?.schemaVersion).toBe(2);
  expect(parseNativeNameProvenance({ ...noEnglish, displayMode: "english" })?.appliedName).toBe("腾远钴业");
  for (const invalid of [{ appliedName: "腾远钴业 / Wrong Company" }, { chineseName: "301219" }, { code: "301218" },
    { englishName: "Different English Name" }, { englishNameEvidence: null }, { displayMode: "unknown" },
    { englishNameEvidence: { ...bilingual().englishNameEvidence!, observedAt: "unknown" } },
    { englishNameEvidence: { ...bilingual().englishNameEvidence!, observedAt: "2026-10-04T04:00:00" } },
    { englishNameEvidence: { ...bilingual().englishNameEvidence!, exchange: "SSE" } },
    { englishNameEvidence: legacy().providerEvidence }, { source: { ...legacy().source, provider: "untrusted" } },
    { source: { ...legacy().source, sourceURL: "https://www.cninfo.com.cn/new/information/topSearch/query?keyWord=301218&maxNum=10" } },
    { source: { ...legacy().source, sourceURL: "https://user:secret@www.cninfo.com.cn/new/information/topSearch/query?keyWord=301219&maxNum=10" } }]) {
    expect(parseNativeNameProvenance({ ...bilingual(), ...invalid })).toBeNull();
  }
  expect(parseNativeNameProvenance({ ...noEnglish, englishNameEvidence: bilingual().englishNameEvidence })).toBeNull();
});
