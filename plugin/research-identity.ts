import { bridgeClient, parseOffsetTimestamp, type BridgeClient, type BridgeResult } from "./client";
import { requireResearchListing } from "./research-symbols";

export interface ResearchIdentitySource {
  provider: "cninfo"; sourceURL: string; receivedAt: string; sha256: string; sourceVersion: null;
}
export interface ResearchSearchCandidate {
  symbol: string; code: string; exchange: "SSE" | "SZSE"; name: string; orgId: string;
  category: "A股"; exchangeBasis: "code_prefix_route"; officialInitials: string; fullPinyin: string | null; generatedInitials: string | null; matchKind: string; identityBasis: "directory_index";
}
export interface ResearchSearchData {
  schemaVersion: 1; mode: "cninfo_shsz_search"; query: string; normalizedQuery: string; limit: number; totalMatches: number;
  candidates: ResearchSearchCandidate[]; pinyin: { provider: "pypinyin"; version: string; derived: true; [key: string]: unknown };
  source: ResearchIdentitySource; limitations: string[];
}
export interface ResearchIdentityData {
  schemaVersion: 1; mode: "cninfo_shsz_identity"; symbol: string; code: string; exchange: "SSE" | "SZSE"; name: string; orgId: string;
  exchangeBasis: "code_prefix_route";
  identityBasis: "official_exact_current_code";
  officialIdentity: { code: string; category: "A股"; type: string; delisted: "false"; orgId: string; zwjc: string; [key: string]: unknown };
  source: ResearchIdentitySource;
}
export type LoadResearchSearch = (query: string, signal?: AbortSignal) => Promise<BridgeResult<ResearchSearchData>>;
export type LoadResearchIdentity = (symbol: string, signal?: AbortSignal) => Promise<BridgeResult<ResearchIdentityData>>;
export interface ResearchIdentityOptions { client?: Pick<BridgeClient, "request"> }

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}响应形状无效。`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /\p{C}/u.test(value)) throw new Error(`${label}未提供或无效。`);
  return value;
}
function source(value: unknown, kind: "search" | "identity"): ResearchIdentitySource {
  const raw = record(value, "证券简称来源"), sourceURL = text(raw.sourceURL, "证券简称来源链接", 2048);
  const url = new URL(sourceURL);
  if (url.protocol !== "https:" || url.hostname !== "www.cninfo.com.cn" || url.port || url.username || url.password || url.hash
    || (kind === "identity" ? url.pathname !== "/new/information/topSearch/query" : url.pathname !== "/new/data/szse_stock.json" || !!url.search)) {
    throw new Error("证券简称来源链接不属于已接入接口。");
  }
  if (raw.provider !== "cninfo" || raw.sourceVersion !== null || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256)) {
    throw new Error("证券简称来源记录无效。");
  }
  const receivedAt = text(raw.receivedAt, "证券简称源获取时间"); parseOffsetTimestamp(receivedAt, "证券简称源获取时间");
  return { provider: "cninfo", sourceURL: url.href, receivedAt, sha256: raw.sha256, sourceVersion: null };
}
function listingIdentity(raw: Record<string, unknown>) {
  const symbol = text(raw.symbol, "证券代码"), listing = requireResearchListing(symbol, text(raw.exchange, "交易所"));
  if (listing.exchange === "BJSE" || symbol !== listing.symbol || raw.code !== listing.code || raw.exchangeBasis !== "code_prefix_route") throw new Error("证券代码与沪深交易所身份不一致。");
  const name = text(raw.name, "中文简称"), orgId = text(raw.orgId, "证券机构标识");
  if (!/^[A-Za-z0-9_-]+$/.test(orgId)) throw new Error("证券机构标识无效。");
  return { symbol, code: listing.code, exchange: listing.exchange, exchangeBasis: "code_prefix_route" as const, name, orgId };
}

export function parseResearchSearch(query: string, result: BridgeResult<unknown>): BridgeResult<ResearchSearchData> {
  const raw = record(result.data, "证券搜索");
  if (raw.schemaVersion !== 1 || raw.mode !== "cninfo_shsz_search" || result.meta.mode !== raw.mode || raw.query !== query) throw new Error("证券搜索协议或查询不一致。");
  const limit = raw.limit, totalMatches = raw.totalMatches;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 10 || !Number.isSafeInteger(totalMatches) || (totalMatches as number) < 0
    || !Array.isArray(raw.candidates) || raw.candidates.length > (limit as number) || raw.candidates.length > (totalMatches as number)) throw new Error("证券搜索数量无效。");
  const seen = new Set<string>();
  const candidates = raw.candidates.map((entry): ResearchSearchCandidate => {
    const candidate = record(entry, "证券搜索候选"), identity = listingIdentity(candidate);
    if (candidate.identityBasis !== "directory_index" || candidate.category !== "A股" || seen.has(identity.symbol)) throw new Error("证券搜索候选重复或身份依据无效。");
    seen.add(identity.symbol);
    const officialInitials = text(candidate.officialInitials, "官方检索缩写"), fullPinyin = candidate.fullPinyin === null ? null : text(candidate.fullPinyin, "生成全拼"), generatedInitials = candidate.generatedInitials === null ? null : text(candidate.generatedInitials, "生成首字母");
    if (!/^[a-z0-9]+$/i.test(officialInitials) || fullPinyin !== null && !/^[a-z0-9]+$/i.test(fullPinyin) || generatedInitials !== null && !/^[a-z0-9]+$/i.test(generatedInitials)) throw new Error("生成拼音形状无效。");
    const matchKind = text(candidate.matchKind, "搜索匹配类型");
    if (!["code_exact", "name_exact", "pinyin_exact", "initials_exact", "code_prefix", "name_prefix", "pinyin_prefix", "initials_prefix", "name_contains", "pinyin_contains", "initials_contains"].includes(matchKind)) throw new Error("证券搜索匹配类型无效。");
    return { ...identity, category: "A股", identityBasis: "directory_index", officialInitials, fullPinyin, generatedInitials, matchKind };
  });
  const pinyin = record(raw.pinyin, "拼音来源");
  if (pinyin.provider !== "pypinyin" || pinyin.derived !== true) throw new Error("拼音应明确标注为生成检索信息。");
  const limitations = raw.limitations;
  if (!Array.isArray(limitations) || limitations.length > 20) throw new Error("搜索范围说明无效。");
  const data: ResearchSearchData = { schemaVersion: 1, mode: "cninfo_shsz_search", query, normalizedQuery: text(raw.normalizedQuery, "规范查询"), limit: limit as number,
    totalMatches: totalMatches as number, candidates, pinyin: { ...structuredClone(pinyin), provider: "pypinyin", version: text(pinyin.version, "拼音组件版本"), derived: true },
    source: source(raw.source, "search"), limitations: limitations.map((item) => text(item, "搜索范围说明", 2048)) };
  if (data.source.receivedAt !== result.meta.receivedAt) throw new Error("证券搜索源获取时间与读取记录不一致。");
  return { data, meta: structuredClone(result.meta) };
}

export function parseResearchIdentity(symbol: string, result: BridgeResult<unknown>): BridgeResult<ResearchIdentityData> {
  const listing = requireResearchListing(symbol), raw = record(result.data, "当前证券简称"), identity = listingIdentity(raw);
  if (raw.schemaVersion !== 1 || raw.mode !== "cninfo_shsz_identity" || result.meta.mode !== raw.mode || identity.symbol !== listing.symbol || raw.identityBasis !== "official_exact_current_code") throw new Error("当前证券简称与查询代码不一致。");
  const official = record(raw.officialIdentity, "当前证券身份核对");
  if (official.code !== identity.code || official.category !== "A股" || official.type !== "shj"
    || official.delisted !== "false" || official.orgId !== identity.orgId || official.zwjc !== identity.name) throw new Error("当前证券身份核对不一致。");
  if (!/^[a-z0-9]+$/i.test(text(official.pinyin, "官方检索缩写"))) throw new Error("官方检索缩写无效。");
  const data: ResearchIdentityData = { schemaVersion: 1, mode: "cninfo_shsz_identity", ...identity,
    identityBasis: "official_exact_current_code", officialIdentity: structuredClone(official) as ResearchIdentityData["officialIdentity"], source: source(raw.source, "identity") };
  const url = new URL(data.source.sourceURL);
  if (url.searchParams.get("keyWord") !== listing.code || url.searchParams.get("maxNum") !== "10") throw new Error("当前证券身份来源请求不一致。");
  if (data.source.receivedAt !== result.meta.receivedAt) throw new Error("当前证券简称源获取时间与读取记录不一致。");
  return { data, meta: structuredClone(result.meta) };
}

export async function loadResearchSearch(query: string, signal?: AbortSignal, options: ResearchIdentityOptions = {}): Promise<BridgeResult<ResearchSearchData>> {
  signal?.throwIfAborted(); text(query, "证券查询", 64);
  if (/\p{C}/u.test(query)) throw new Error("证券查询含无效控制字符。");
  const result = await (options.client ?? bridgeClient).request("/v1/research-symbols", { q: query, limit: "10" }, signal);
  signal?.throwIfAborted(); return parseResearchSearch(query, result);
}
export async function loadResearchIdentity(symbol: string, signal?: AbortSignal, options: ResearchIdentityOptions = {}): Promise<BridgeResult<ResearchIdentityData>> {
  const listing = requireResearchListing(symbol); if (listing.exchange === "BJSE") throw new Error("此中文简称接口仅用于沪深证券。");
  signal?.throwIfAborted();
  const result = await (options.client ?? bridgeClient).request("/v1/research-identity", { symbol: listing.symbol }, signal);
  signal?.throwIfAborted(); return parseResearchIdentity(listing.symbol, result);
}
