import type { InstrumentSearchResult } from "gloomberb/types/instrument";
import type { Quote } from "gloomberb/types/financials";
import type { ResearchIdentityData } from "./research-identity";
import { resolveResearchListing, type ResearchListing } from "./research-symbols";

export type NativeNameDisplayMode = "bilingual" | "chinese" | "english";
export type NativeNameOwnershipBasis = "placeholder" | "plugin_owned" | "native_quote" | "cloud_search";
export interface NativeNameOwnershipEvidence { providerId: string; symbol: string; exchange: string; currency: string; name: string }
export interface NativeProviderNameEvidence extends NativeNameOwnershipEvidence {
  instrumentType: string;
  /** Local verification time of this lookup, not the provider's publication or price time. */
  observedAt: string;
}
interface NativeNameProvenanceBase {
  managedBy: "ashare-local"; symbol: string; code: string; exchange: "SSE" | "SZSE";
  orgId: string; previousName: string; appliedName: string; appliedAt: string; ownershipBasis: NativeNameOwnershipBasis;
  source: ResearchIdentityData["source"]; providerEvidence: NativeNameOwnershipEvidence | null;
}
export interface NativeNameProvenanceV1 extends NativeNameProvenanceBase { schemaVersion: 1 }
export interface NativeNameProvenanceV2 extends NativeNameProvenanceBase {
  schemaVersion: 2; chineseName: string; englishName: string | null;
  englishNameEvidence: NativeProviderNameEvidence | null; displayMode: NativeNameDisplayMode;
}
export type NativeNameProvenance = NativeNameProvenanceV1 | NativeNameProvenanceV2;

const providers = new Set(["gloomberb-cloud", "yahoo", "yahoo-finance"]);
const bases = new Set<NativeNameOwnershipBasis>(["placeholder", "plugin_owned", "native_quote", "cloud_search"]);
const control = /[\p{Cc}\p{Cf}]/u;
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function time(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}
export function nativeNameEquity(type: unknown): boolean {
  return typeof type === "string" && ["STK", "STOCK", "EQUITY", "COMMON STOCK"].includes(type.trim().toUpperCase());
}
export function resolveNativeNameDisplayMode(config: unknown): NativeNameDisplayMode {
  const mode = object(object(object(config)?.pluginConfig)?.["ashare-local"])?.nameDisplay;
  return mode === "chinese" || mode === "english" ? mode : "bilingual";
}
/** A missing sourced English name always falls back to the verified Chinese name. */
export function formatNativeName(chineseName: string, englishName: string | null, mode: NativeNameDisplayMode): string {
  if (!englishName || mode === "chinese") return chineseName;
  return mode === "english" ? englishName : `${chineseName} · ${englishName}`;
}
export function usableNativeEnglishName(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 240
    && /[A-Za-z]/.test(value) && !/\p{Script=Han}/u.test(value) && !control.test(value)
    && !resolveResearchListing(value) && !/^\d{6}(?:[.:_\s-]+[A-Za-z]{2,12}|\s*\([A-Za-z]{2,12}\))?$/.test(value);
}
function validChineseName(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 240
    && /\p{Script=Han}/u.test(value) && !control.test(value);
}
function ownershipEvidence(value: unknown, listing: ResearchListing): NativeNameOwnershipEvidence | null {
  const row = object(value);
  return row && typeof row.providerId === "string" && providers.has(row.providerId)
    && typeof row.symbol === "string" && typeof row.exchange === "string" && row.exchange.trim() !== ""
    && row.currency === "CNY" && typeof row.name === "string" && !control.test(row.name)
    && resolveResearchListing(row.symbol, row.exchange)?.symbol === listing.symbol
    ? row as unknown as NativeNameOwnershipEvidence : null;
}
export function parseNativeProviderNameEvidence(value: unknown, listing: ResearchListing): NativeProviderNameEvidence | null {
  const row = object(value), base = ownershipEvidence(value, listing);
  return base && row && usableNativeEnglishName(row.name) && nativeNameEquity(row.instrumentType) && time(row.observedAt)
    ? row as unknown as NativeProviderNameEvidence : null;
}
/** Search and quote English names are checked independently of permission to replace a stored name. */
export function nativeSearchEnglishEvidence(rows: readonly InstrumentSearchResult[], listing: ResearchListing, observedAt: string): NativeProviderNameEvidence | null {
  const matches = rows.flatMap((row) => {
    if (row.brokerContract || !row.exchange || !row.currency || control.test(row.name)) return [];
    const evidence = parseNativeProviderNameEvidence({ providerId: row.providerId, symbol: row.symbol,
      exchange: row.exchange, currency: row.currency, name: row.name.trim(), instrumentType: row.type, observedAt }, listing);
    return evidence ? [evidence] : [];
  });
  // Conflicting exact-listing names are not a license to choose an arbitrary alias.
  return new Set(matches.map((row) => row.name)).size === 1 ? matches[0]! : null;
}
export function nativeQuoteEnglishEvidence(quote: Quote | null | undefined, listing: ResearchListing, observedAt: string): NativeProviderNameEvidence | null {
  if (!quote?.name || control.test(quote.name)) return null;
  return parseNativeProviderNameEvidence({ providerId: quote.provenance?.descriptive?.providerId ?? quote.providerId,
    symbol: quote.symbol, exchange: quote.listingExchangeName || quote.exchangeName, currency: quote.currency,
    name: quote.name.trim(), instrumentType: quote.instrumentType, observedAt }, listing);
}

/** Both versions can prove ownership; only v2 carries a separately verified English name. */
export function parseNativeNameProvenance(value: unknown): NativeNameProvenance | null {
  const row = object(value);
  if (!row || (row.schemaVersion !== 1 && row.schemaVersion !== 2) || row.managedBy !== "ashare-local"
    || typeof row.symbol !== "string" || typeof row.code !== "string" || (row.exchange !== "SSE" && row.exchange !== "SZSE")
    || typeof row.orgId !== "string" || !row.orgId || typeof row.previousName !== "string"
    || typeof row.appliedName !== "string" || !row.appliedName || !time(row.appliedAt)
    || !bases.has(row.ownershipBasis as NativeNameOwnershipBasis)) return null;
  const listing = resolveResearchListing(row.symbol, row.exchange), source = object(row.source);
  if (!listing || listing.symbol !== row.symbol || listing.code !== row.code
    || !source || source.provider !== "cninfo" || typeof source.sourceURL !== "string" || !time(source.receivedAt)
    || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(source.sha256)
    || source.sourceVersion !== null) return null;
  let sourceURL: URL;
  try { sourceURL = new URL(source.sourceURL); } catch { return null; }
  if (sourceURL.protocol !== "https:" || sourceURL.hostname !== "www.cninfo.com.cn" || sourceURL.port
    || sourceURL.username || sourceURL.password || sourceURL.hash || sourceURL.pathname !== "/new/information/topSearch/query"
    || sourceURL.searchParams.get("keyWord") !== listing.code || sourceURL.searchParams.get("maxNum") !== "10") return null;
  if (row.providerEvidence !== null && !ownershipEvidence(row.providerEvidence, listing)) return null;
  if (row.schemaVersion === 1) return validChineseName(row.appliedName) ? row as unknown as NativeNameProvenanceV1 : null;
  if (!validChineseName(row.chineseName) || !["bilingual", "chinese", "english"].includes(row.displayMode as string)) return null;
  if (row.englishName === null) {
    if (row.englishNameEvidence !== null) return null;
  } else {
    const evidence = parseNativeProviderNameEvidence(row.englishNameEvidence, listing);
    if (!usableNativeEnglishName(row.englishName) || evidence?.name !== row.englishName) return null;
  }
  if (row.appliedName !== formatNativeName(row.chineseName, row.englishName as string | null, row.displayMode as NativeNameDisplayMode)) return null;
  return row as unknown as NativeNameProvenanceV2;
}
