import { DEFAULT_PORTFOLIO_COLUMN_IDS } from "gloomberb/types/config";
import type { Quote } from "gloomberb/types/financials";
import type { InstrumentSearchResult } from "gloomberb/types/instrument";
import type { GloomPluginContext } from "gloomberb/types/plugin";
import type { TickerRecord } from "gloomberb/types/ticker";
import { loadResearchIdentity, parseResearchIdentity, type LoadResearchIdentity, type ResearchIdentityData } from "./research-identity";
import { resolveResearchListing, type ResearchListing } from "./research-symbols";
import { waitForNativeNameRetry } from "./native-name-retry";
import { formatNativeName, nativeNameEquity, nativeQuoteEnglishEvidence, nativeSearchEnglishEvidence, parseNativeNameProvenance,
  resolveNativeNameDisplayMode, type NativeNameOwnershipBasis, type NativeNameOwnershipEvidence,
  type NativeNameProvenance, type NativeNameProvenanceV2 } from "./native-name-model";

export { formatNativeName, parseNativeNameProvenance, resolveNativeNameDisplayMode } from "./native-name-model";
export type { NativeNameDisplayMode, NativeNameProvenance, NativeNameProvenanceV1, NativeNameProvenanceV2, NativeProviderNameEvidence } from "./native-name-model";

export const NATIVE_NAME_PROVENANCE_KEY = "ashareNativeName";
type NameContext = Pick<GloomPluginContext, "getConfig" | "getData" | "tickerRepository" | "marketData" | "paneSettings">;
type NameBasis = NativeNameOwnershipBasis;
type ProviderNameEvidence = NativeNameOwnershipEvidence;
export interface NativeNameSyncResult {
  changedRecords: TickerRecord[];
  skipped: Array<{ symbol: string; reason: string; retryable?: boolean; stage?: "identity" | "search" | "record" | "save" }>;
  columns: { changed: string[]; skippedGrid: string[] };
}
export interface NativeNameSyncOptions {
  identityLoad?: LoadResearchIdentity;
  signal?: AbortSignal;
  symbols?: readonly string[];
  updateColumns?: boolean;
  onSaved?: (ticker: TickerRecord) => void | Promise<void>;
  now?: () => string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const equity = nativeNameEquity;
async function cancellableRead<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** Keep security keys untouched. Only real Shanghai/Shenzhen equity collection members qualify. */
function memberListing(ctx: NameContext, ticker: TickerRecord): ResearchListing | null {
  const metadata = ticker.metadata, config = ctx.getConfig();
  if (config.disabledPlugins?.includes("ashare-local")) return null;
  if (!equity(metadata.assetCategory) || metadata.currency !== "CNY") return null;
  const listing = resolveResearchListing(metadata.ticker, metadata.exchange);
  if (!listing || listing.exchange === "BJSE" || !metadata.exchange) return null;
  const portfolios = new Set(config.portfolios.map((item) => item.id)), watchlists = new Set(config.watchlists.map((item) => item.id));
  const member = metadata.portfolios.some((id) => portfolios.has(id)) || metadata.watchlists.some((id) => watchlists.has(id))
    || metadata.positions.some((position) => portfolios.has(position.portfolio));
  return member ? listing : null;
}

/** Keep an existing NAME where the user put it; only insert when absent. */
export function withNativeNameColumn(columns: readonly string[]): string[] {
  if (columns.includes("name")) {
    let seen = false;
    return columns.filter((column) => column !== "name" || (!seen && (seen = true)));
  }
  const next = [...columns];
  const ticker = next.indexOf("ticker");
  next.splice(ticker < 0 ? 0 : ticker + 1, 0, "name");
  return next;
}

export async function enableNativeNameColumns(ctx: Pick<NameContext, "getConfig" | "paneSettings">, signal?: AbortSignal): Promise<NativeNameSyncResult["columns"]> {
  const result: NativeNameSyncResult["columns"] = { changed: [], skippedGrid: [] };
  if (ctx.getConfig().disabledPlugins?.includes("ashare-local")) return result;
  for (const pane of ctx.getConfig().layout.instances) {
    signal?.throwIfAborted();
    if (pane.paneId !== "portfolio-list") continue;
    // A grid does not consume columns. Do not pretend NAME can change its label.
    if (ctx.paneSettings.get(pane.instanceId, "viewMode") === "grid") { result.skippedGrid.push(pane.instanceId); continue; }
    const raw = ctx.paneSettings.get<unknown>(pane.instanceId, "columnIds");
    const selected = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
    const columns = selected.length ? selected : DEFAULT_PORTFOLIO_COLUMN_IDS;
    const next = withNativeNameColumn(columns);
    if (columns.length === next.length && columns.every((column, index) => column === next[index])) continue;
    signal?.throwIfAborted();
    await ctx.paneSettings.set(pane.instanceId, "columnIds", next);
    signal?.throwIfAborted();
    result.changed.push(pane.instanceId);
  }
  return result;
}

function knownIdentityMatches(ticker: TickerRecord, identity: ResearchIdentityData): boolean {
  for (const key of ["ashareChineseIdentity", NATIVE_NAME_PROVENANCE_KEY]) {
    const previous = object(ticker.metadata.custom[key]);
    if (!previous) continue;
    if (typeof previous.orgId === "string" && previous.orgId !== identity.orgId) return false;
    if (typeof previous.symbol === "string" && resolveResearchListing(previous.symbol)?.symbol !== identity.symbol) return false;
  }
  return true;
}
function ownedName(ticker: TickerRecord, identity: ResearchIdentityData): NativeNameProvenance | null {
  const prior = parseNativeNameProvenance(ticker.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]);
  return prior && prior.symbol === identity.symbol
    && prior.code === identity.code && prior.exchange === identity.exchange && prior.orgId === identity.orgId
    && prior.appliedName === ticker.metadata.name && typeof prior.previousName === "string"
    ? prior : null;
}
function placeholder(name: string, ticker: TickerRecord, listing: ResearchListing): boolean {
  const value = name.trim().toUpperCase();
  return !value || value === ticker.metadata.ticker.toUpperCase() || value === listing.code
    || resolveResearchListing(value)?.symbol === listing.symbol;
}
function quoteEvidence(quote: Quote | null | undefined, ticker: TickerRecord, listing: ResearchListing): ProviderNameEvidence | null {
  if (!quote || quote.name !== ticker.metadata.name || quote.currency !== "CNY") return null;
  const providerId = quote.provenance?.descriptive?.providerId ?? quote.providerId;
  if (!providerId || !["gloomberb-cloud", "yahoo", "yahoo-finance"].includes(providerId)) return null;
  const exchange = quote.listingExchangeName || quote.exchangeName;
  if (!exchange || resolveResearchListing(quote.symbol, exchange)?.symbol !== listing.symbol
    || (quote.instrumentType && !equity(quote.instrumentType))) return null;
  return { providerId, symbol: quote.symbol, exchange, currency: quote.currency, name: quote.name };
}
function searchEvidence(rows: readonly InstrumentSearchResult[], ticker: TickerRecord, listing: ResearchListing): ProviderNameEvidence | null {
  const matches = rows.filter((row) => ["gloomberb-cloud", "yahoo", "yahoo-finance"].includes(row.providerId) && row.name === ticker.metadata.name
    && row.currency === "CNY" && equity(row.type) && !row.brokerContract
    && resolveResearchListing(row.symbol, row.exchange)?.symbol === listing.symbol);
  const row = matches[0];
  return row ? { providerId: row.providerId, symbol: row.symbol, exchange: row.exchange, currency: row.currency!, name: row.name } : null;
}

/** One finite, cancellable pass. Saves do not invent a ticker:updated host event. */
export async function syncNativeNames(ctx: NameContext, options: NativeNameSyncOptions = {}): Promise<NativeNameSyncResult> {
  const signal = options.signal, identityLoad = options.identityLoad ?? loadResearchIdentity;
  const result: NativeNameSyncResult = { changedRecords: [], skipped: [], columns: { changed: [], skippedGrid: [] } };
  signal?.throwIfAborted();
  if (options.updateColumns !== false) result.columns = await enableNativeNameColumns(ctx, signal);
  const all = await cancellableRead(ctx.tickerRepository.loadAllTickers(), signal);
  signal?.throwIfAborted();
  const requested = options.symbols ? new Set(options.symbols) : null;
  const identities = new Map<string, ResearchIdentityData>(), searches = new Map<string, InstrumentSearchResult[]>();
  for (const original of all) {
    signal?.throwIfAborted();
    const symbol = original.metadata.ticker;
    if (requested && !requested.has(symbol)) continue;
    const listing = memberListing(ctx, original);
    if (!listing) { result.skipped.push({ symbol, reason: "outside_native_ashare_collection_scope" }); continue; }
    let stage: "identity" | "search" | "record" | "save" = "identity";
    const displayMode = resolveNativeNameDisplayMode(ctx.getConfig());
    try {
      let identity = identities.get(listing.symbol);
      if (!identity) {
        const loaded = await cancellableRead(identityLoad(listing.symbol, signal), signal);
        signal?.throwIfAborted();
        identity = parseResearchIdentity(listing.symbol, loaded).data;
        if (!/\p{Script=Han}/u.test(identity.name)) throw new Error("官方简称未提供中文名称。");
        identities.set(listing.symbol, identity);
      }
      if (!knownIdentityMatches(original, identity)) { result.skipped.push({ symbol, reason: "issuer_identity_conflict" }); continue; }
      const originalOwned = ownedName(original, identity);
      // A user-authored name equal to the official Chinese name does not grant
      // ownership. Owned v1 records must still migrate even when NAME is unchanged.
      if (displayMode === "chinese" && original.metadata.name === identity.name && !originalOwned) continue;
      let rows = searches.get(listing.symbol);
      const cached = quoteEvidence(ctx.getData(symbol)?.quote, original, listing);
      const retainedEnglish = originalOwned?.schemaVersion === 2 && originalOwned.chineseName === identity.name
        ? originalOwned.englishNameEvidence : null;
      const needsOwnership = !placeholder(original.metadata.name, original, listing) && !originalOwned && !cached;
      const needsEnglish = displayMode !== "chinese" && !retainedEnglish;
      if ((needsOwnership || needsEnglish) && !rows) {
        stage = "search";
        try { rows = await cancellableRead(ctx.marketData.search(listing.code, { preferBroker: false }), signal); }
        catch {
          signal?.throwIfAborted();
          // An English lookup failure does not revoke existing ownership or a
          // verified Chinese identity. Save the fallback and retry once.
          if (needsOwnership) throw new Error("native_name_ownership_search_unavailable");
          rows = [];
        }
        signal?.throwIfAborted();
        searches.set(listing.symbol, rows);
      }
      // Lookup can outlive a portfolio or name edit. Merge from the fresh saved record.
      stage = "record";
      const latest = await cancellableRead(ctx.tickerRepository.loadTicker(symbol), signal);
      signal?.throwIfAborted();
      const freshListing = latest && memberListing(ctx, latest);
      if (!latest || freshListing?.symbol !== listing.symbol || !knownIdentityMatches(latest, identity)) {
        result.skipped.push({ symbol, reason: "identity_or_membership_changed" }); continue;
      }
      if (resolveNativeNameDisplayMode(ctx.getConfig()) !== displayMode) {
        result.skipped.push({ symbol, reason: "name_display_mode_changed", stage: "record" }); continue;
      }
      const owned = ownedName(latest, identity);
      if (latest.metadata.name !== original.metadata.name && !owned) {
        result.skipped.push({ symbol, reason: "preserved_concurrent_name_edit" }); continue;
      }
      if (displayMode === "chinese" && latest.metadata.name === identity.name && !owned) continue;
      const freshQuote = quoteEvidence(ctx.getData(symbol)?.quote, latest, listing);
      const provider = freshQuote ?? searchEvidence(rows ?? [], latest, listing);
      const basis: NameBasis | null = placeholder(latest.metadata.name, latest, listing) ? "placeholder"
        : owned ? "plugin_owned" : provider ? (freshQuote ? "native_quote" : "cloud_search") : null;
      if (!basis) {
        // Empty results can be a provider outage hidden by the host router.
        // They do not prove that the current name is a user-authored label.
        const unavailable = rows?.length === 0;
        result.skipped.push({ symbol, reason: unavailable ? "provider_evidence_unavailable" : "preserved_custom_name",
          ...(unavailable ? { retryable: true, stage: "search" as const } : {}) });
        continue;
      }
      const observedAt = (options.now ?? (() => new Date().toISOString()))();
      const ownedEnglish = owned?.schemaVersion === 2 && owned.chineseName === identity.name ? owned.englishNameEvidence : null;
      const englishEvidence = rows ? nativeSearchEnglishEvidence(rows, listing, observedAt)
        ?? (rows.length === 0 ? nativeQuoteEnglishEvidence(ctx.getData(symbol)?.quote, listing, observedAt) : null)
        : ownedEnglish ?? nativeQuoteEnglishEvidence(ctx.getData(symbol)?.quote, listing, observedAt);
      const englishName = englishEvidence?.name ?? null;
      const appliedName = formatNativeName(identity.name, englishName, displayMode);
      const missingEnglish = displayMode !== "chinese" && !englishEvidence && rows?.length === 0;
      if (missingEnglish) result.skipped.push({ symbol, reason: "english_name_evidence_unavailable", retryable: true, stage: "search" });
      if (owned?.schemaVersion === 2 && owned.chineseName === identity.name && owned.englishName === englishName
        && owned.displayMode === displayMode && owned.appliedName === appliedName) continue;
      const provenance: NativeNameProvenanceV2 = {
        schemaVersion: 2, managedBy: "ashare-local", symbol: identity.symbol, code: identity.code, exchange: identity.exchange,
        orgId: identity.orgId, previousName: owned?.previousName ?? latest.metadata.name, appliedName,
        appliedAt: observedAt, ownershipBasis: basis, chineseName: identity.name, englishName,
        englishNameEvidence: englishEvidence ? structuredClone(englishEvidence) : null, displayMode,
        source: structuredClone(identity.source), providerEvidence: owned?.providerEvidence ??
          (basis === "native_quote" || basis === "cloud_search" ? provider : null),
      };
      if (!parseNativeNameProvenance(provenance)) throw new Error("native_name_provenance_invalid");
      const updated = { ...latest, metadata: { ...latest.metadata, name: appliedName,
        custom: { ...latest.metadata.custom, [NATIVE_NAME_PROVENANCE_KEY]: provenance } } };
      signal?.throwIfAborted();
      stage = "save";
      await ctx.tickerRepository.saveTicker(updated);
      signal?.throwIfAborted();
      result.changedRecords.push(updated);
      await options.onSaved?.(updated);
    } catch {
      signal?.throwIfAborted();
      result.skipped.push({ symbol, reason: "native_name_sync_failed", retryable: true, stage });
    }
  }
  return result;
}

export interface NativeNameLifecycleOptions extends NativeNameSyncOptions {
  waitForRetry?: (signal: AbortSignal) => Promise<void>;
}
function mergeNamePasses(first: NativeNameSyncResult, second: NativeNameSyncResult, symbols: readonly string[]): NativeNameSyncResult {
  const replaced = new Set(symbols);
  return { changedRecords: [...first.changedRecords, ...second.changedRecords],
    skipped: [...first.skipped.filter((item) => !replaced.has(item.symbol)), ...second.skipped], columns: first.columns };
}

/** Setup/new-membership events, with one bounded retry; no polling or added event replay. */
export function createNativeNameLifecycle(ctx: NameContext & Pick<GloomPluginContext, "on" | "log">, options: NativeNameLifecycleOptions = {}) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let modeController = new AbortController();
  let tail: Promise<unknown> = Promise.resolve();
  const run = (symbols?: readonly string[]) => {
    const taskSignal = AbortSignal.any([signal, modeController.signal]);
    const task = tail.then(async () => {
      taskSignal.throwIfAborted();
      let first: NativeNameSyncResult;
      try {
        first = await syncNativeNames(ctx, { ...options, symbols, signal: taskSignal });
      } catch {
        taskSignal.throwIfAborted();
        ctx.log.warn("Native name sync unavailable; one retry scheduled.");
        await cancellableRead((options.waitForRetry ?? waitForNativeNameRetry)(taskSignal), taskSignal);
        taskSignal.throwIfAborted();
        const second = await syncNativeNames(ctx, { ...options, symbols, signal: taskSignal });
        for (const item of second.skipped.filter((item) => item.retryable)) {
          ctx.log.warn(`Native name sync remains unavailable for ${item.symbol} (${item.reason}; stage=${item.stage}); retry exhausted.`);
        }
        return second;
      }
      // A desktop renderer can request names before its configuration commit
      // reaches the backend. That host does not emit the backend config event.
      // Recover only members skipped at that boundary, once, without a delay.
      const modeSymbols = first.skipped.filter((item) => item.reason === "name_display_mode_changed").map((item) => item.symbol);
      if (modeSymbols.length) {
        taskSignal.throwIfAborted();
        const repaired = await syncNativeNames(ctx, { ...options, symbols: modeSymbols, signal: taskSignal, updateColumns: false });
        first = mergeNamePasses(first, repaired, modeSymbols);
      }
      // A mode repair is already the member's second pass. Never turn another
      // mode change or failure in that pass into a third attempt.
      const repairedSymbols = new Set(modeSymbols);
      const retrySymbols = first.skipped.filter((item) => item.retryable && !repairedSymbols.has(item.symbol)).map((item) => item.symbol);
      if (!retrySymbols.length) return first;
      for (const item of first.skipped.filter((item) => item.retryable)) {
        ctx.log.warn(`Native name sync deferred for ${item.symbol} (${item.reason}; stage=${item.stage}); one retry scheduled.`);
      }
      await cancellableRead((options.waitForRetry ?? waitForNativeNameRetry)(taskSignal), taskSignal);
      taskSignal.throwIfAborted();
      // Re-read the current repository and repeat all ownership checks. Retry
      // only the failed members, never the entire collection or old holdings.
      const second = await syncNativeNames(ctx, { ...options, symbols: retrySymbols, signal: taskSignal, updateColumns: false });
      for (const item of second.skipped.filter((item) => item.retryable)) {
        ctx.log.warn(`Native name sync remains unavailable for ${item.symbol} (${item.reason}; stage=${item.stage}); retry exhausted.`);
      }
      if (second.changedRecords.length) ctx.log.info(`Native name retry recovered ${second.changedRecords.length} record(s).`);
      return mergeNamePasses(first, second, retrySymbols);
    });
    tail = task.catch(() => { if (!taskSignal.aborted) ctx.log.warn("Native name sync unavailable; retry exhausted."); });
    return task;
  };
  const unsubscribe = ctx.on("ticker:added", ({ symbol }) => { void run([symbol]).catch(() => {}); });
  let lastDisplayMode = resolveNativeNameDisplayMode(ctx.getConfig());
  const unsubscribeConfig = ctx.on("config:changed", () => {
    const next = resolveNativeNameDisplayMode(ctx.getConfig());
    if (next === lastDisplayMode) return;
    lastDisplayMode = next;
    modeController.abort();
    modeController = new AbortController();
    void run(options.symbols).catch(() => {});
  });
  const ready = run(options.symbols);
  return { ready, sync: () => run(options.symbols), shutdown() { controller.abort(); unsubscribe(); unsubscribeConfig(); } };
}
