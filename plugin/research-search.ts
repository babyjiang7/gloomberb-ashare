import { getCapabilityStreamClient } from "gloomberb/capabilities";
import { upsertTickerFromSearchResult } from "gloomberb/tickers";
import { canonicalExchange, publicTickerKey } from "gloomberb/utils";
import type { CommandBarResultDef, CommandBarSearchProvider, GloomPluginContext } from "gloomberb/types/plugin";
import type { TickerRecord } from "gloomberb/types/ticker";
import { BridgeClient, BridgeError, type BridgeResult } from "./client";
import {
  loadResearchIdentity, loadResearchSearch, parseResearchIdentity, parseResearchSearch,
  type LoadResearchIdentity, type LoadResearchSearch, type ResearchIdentityData, type ResearchSearchCandidate,
} from "./research-identity";

type SearchContext = Pick<GloomPluginContext, "tickerRepository" | "pinTicker" | "log" | "notify" | "emit" | "getConfig" | "openCommandBar">;
export interface ResearchSearchLoaders { searchLoad?: LoadResearchSearch; identityLoad?: LoadResearchIdentity }
export interface ResearchSearchProvider extends CommandBarSearchProvider { dispose(): void }
type SelectionAction = "research" | "watchlist" | "portfolio";

/** The public desktop client is installed before external plugin setup. No pane needs to mount. */
export function createDesktopResearchSearchClient(): BridgeClient {
  return new BridgeClient(undefined, {
    async transport(path, params, signal) {
      signal?.throwIfAborted();
      const client = getCapabilityStreamClient();
      if (!client) throw new BridgeError("SERVICE_UNAVAILABLE", "证券搜索服务尚未准备好。");
      // The non-hook public client has no abort argument. Ignore an old answer
      // after cancellation; do not claim that its underlying RPC was stopped.
      const result = await client.invoke<BridgeResult<unknown>>("ashare-local.bridge", "request", { path, params });
      signal?.throwIfAborted();
      return result;
    },
  });
}

function searchQuery(input: string): string {
  return input.trim();
}

function searchStatusRow(id: string, label: string, detail: string): CommandBarResultDef {
  return { id: `ashare-search:${id}`, label, detail,
    lines: [{ segments: [{ text: detail, emphasis: "muted" }] }], disabled: true, execute() {} };
}

async function verifyCandidate(candidate: ResearchSearchCandidate, identityLoad: LoadResearchIdentity,
  signal: AbortSignal, checkCurrent: () => void) {
  // A directory hit is a candidate, not a current issuer verification. Resolve
  // it once more when selected and keep the host's financial provider intact.
  const result = await identityLoad(candidate.symbol, signal);
  checkCurrent();
  const { data: identity, meta } = parseResearchIdentity(candidate.symbol, result);
  if (identity.symbol !== candidate.symbol || identity.code !== candidate.code || identity.exchange !== candidate.exchange
    || identity.orgId !== candidate.orgId) throw new Error("证券身份已变化，请重新搜索并选择。");
  return { identity, meta, key: publicTickerKey(identity.code, identity.exchange) };
}

function validateSavedIdentity(record: TickerRecord | null, key: string, identity: ResearchIdentityData): void {
  if (!record) return;
  const held = record.metadata;
  if (held.ticker !== key || (held.exchange && canonicalExchange(held.exchange) !== identity.exchange)
    || (held.currency && held.currency !== "CNY")
    || (held.assetCategory && !["STK", "STOCK", "EQUITY", "COMMON STOCK"].includes(held.assetCategory.trim().toUpperCase()))) {
    throw new Error("已有证券的身份、交易所或币种与查询结果不一致。");
  }
  const prior = held.custom?.ashareChineseIdentity as { symbol?: string; orgId?: string } | undefined;
  if (prior && (prior.symbol !== identity.symbol || prior.orgId !== identity.orgId)) {
    throw new Error("已有证券的机构身份与查询结果不一致。");
  }
}

async function openResearchCandidate(ctx: SearchContext, verified: Awaited<ReturnType<typeof verifyCandidate>>,
  checkCurrent: () => void): Promise<void> {
  const { identity, meta, key } = verified;
  const existing = await ctx.tickerRepository.loadTicker(key);
  checkCurrent();
  validateSavedIdentity(existing, key, identity);
  if (!existing) {
    await upsertTickerFromSearchResult(ctx.tickerRepository, {
      providerId: "ashare-local.search", symbol: identity.code, name: identity.name,
      exchange: identity.exchange, type: "STK", currency: "CNY",
    }, { tickerSymbol: key });
    checkCurrent();
  }
  // Re-read after awaits. A research identity annotation must not restore an
  // earlier position, membership, custom name or analyst edit.
  const latest = await ctx.tickerRepository.loadTicker(key);
  checkCurrent();
  if (!latest) throw new Error("证券记录已变化，请重新搜索并选择。");
  validateSavedIdentity(latest, key, identity);
  const ticker = { ...latest, metadata: { ...latest.metadata,
    custom: { ...latest.metadata.custom, ashareChineseIdentity: {
      symbol: identity.symbol, orgId: identity.orgId, name: identity.name,
      exchangeBasis: identity.exchangeBasis, source: identity.source,
      returnedAt: meta.returnedAt ?? null,
    } },
  } };
  await ctx.tickerRepository.saveTicker(ticker);
  checkCurrent();
  ctx.emit("ticker:added", { symbol: ticker.metadata.ticker, ticker });
  // The host uses listing.name in this pane's view without replacing an
  // existing shared ticker's English or user-chosen name.
  ctx.pinTicker(ticker.metadata.ticker, { floating: true, paneType: "ticker-research", instrument: null,
    listing: { name: identity.name, exchange: identity.exchange, currency: "CNY", type: "STK" }, tabId: "overview" });
}

export function createResearchSearchProvider(ctx: SearchContext, loaders: ResearchSearchLoaders = {}): ResearchSearchProvider {
  const searchLoad = loaders.searchLoad ?? loadResearchSearch;
  const identityLoad = loaders.identityLoad ?? loadResearchIdentity;
  let selectionGeneration = 0;
  let selectionController: AbortController | null = null;
  let pendingHandoff: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let searchGeneration = 0;
  const searchControllers = new Set<AbortController>();
  const enabled = () => !disposed && !ctx.getConfig().disabledPlugins?.includes("ashare-local");
  const available = (action: SelectionAction) => {
    const config = ctx.getConfig();
    return action === "research" || (action === "watchlist"
      ? config.watchlists.length > 0
      : config.portfolios.some((portfolio) => !portfolio.brokerId && !portfolio.brokerInstanceId));
  };
  const cancelSelection = () => {
    selectionGeneration++;
    selectionController?.abort();
    selectionController = null;
    if (pendingHandoff !== null) clearTimeout(pendingHandoff);
    pendingHandoff = null;
  };
  const executeCandidate = async (candidate: ResearchSearchCandidate, action: SelectionAction) => {
    cancelSelection();
    if (!enabled() || !available(action)) return;
    const generation = selectionGeneration, controller = new AbortController();
    selectionController = controller;
    const isCurrent = () => enabled() && generation === selectionGeneration && !controller.signal.aborted;
    const checkCurrent = () => {
      controller.signal.throwIfAborted();
      if (!isCurrent()) throw new DOMException("证券选择已更新。", "AbortError");
    };
    try {
      const verified = await verifyCandidate(candidate, identityLoad, controller.signal, checkCurrent);
      if (action === "research") {
        await openResearchCandidate(ctx, verified, checkCurrent);
        return;
      }
      checkCurrent();
      if (!available(action)) return;
      // The host awaits execute() and then closes the search. Reopen once in
      // the next task, with a verified code only. The native AW/AP row still
      // requires the user to activate it; this does not run a command or save.
      pendingHandoff = setTimeout(() => {
        pendingHandoff = null;
        if (!isCurrent() || !available(action)) return;
        ctx.openCommandBar(`${action === "watchlist" ? "AW" : "AP"} ${verified.key}`);
      }, 0);
    } catch (error) {
      if (!isCurrent()) return;
      ctx.log.warn(`A-share selection failed: ${error instanceof Error ? error.message : String(error)}`);
      ctx.notify({ body: error instanceof Error ? error.message : "证券资料暂时无法核对，请重试。", type: "error" });
    }
  };
  return {
    id: "ashare-local:research-search", category: "沪深 A 股", priority: 20, minQueryLength: 2, debounceMs: 250,
    async provide(input, _context, signal) {
      const generation = ++searchGeneration;
      const query = searchQuery(input);
      if (!enabled() || !query || query.length > 64 || /\p{C}/u.test(query)) return [];
      const controller = new AbortController();
      const isCurrent = () => enabled() && generation === searchGeneration && !controller.signal.aborted;
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      searchControllers.add(controller);
      try {
        controller.signal.throwIfAborted();
        const loaded = await searchLoad(query, controller.signal);
        controller.signal.throwIfAborted();
        if (!isCurrent()) return [];
        const result = parseResearchSearch(query, loaded);
        const rows = result.data.candidates.flatMap((candidate) => {
          const common = {
            right: candidate.symbol,
            keywords: [candidate.code, candidate.name, candidate.officialInitials, candidate.fullPinyin ?? "", candidate.generatedInitials ?? ""],
          };
          const venue = candidate.exchange === "SSE" ? "上海证券交易所" : "深圳证券交易所";
          const rows: CommandBarResultDef[] = [{
            id: `ashare-search:${candidate.symbol}`, label: candidate.name,
            ...common, detail: venue, execute: () => executeCandidate(candidate, "research"),
          }];
          for (const action of ["watchlist", "portfolio"] as const) {
            if (available(action)) rows.push({
              id: `ashare-search:${candidate.symbol}:${action}`,
              label: `${candidate.name} · ${action === "watchlist" ? "加入自选" : "加入组合"}`,
              ...common, detail: `${venue} · 进入原生添加流程`,
              execute: () => executeCandidate(candidate, action),
            });
          }
          return rows;
        });
        if (!result.data.candidates.length) rows.push(searchStatusRow("empty", "未找到匹配的沪深股票", "试试完整公司简称或六位代码。"));
        // Preserve candidate/action order and keep the inert hint after choices.
        if (result.data.totalMatches > result.data.candidates.length) rows.push(searchStatusRow("truncated", "候选较多，请细化查询", "输入更完整的简称、拼音或代码。"));
        return rows;
      } catch {
        if (!isCurrent()) return [];
        ctx.log.warn("A-share search unavailable.");
        return [searchStatusRow("unavailable", "沪深股票搜索暂不可用", "请稍后重试。")];
      } finally {
        signal.removeEventListener("abort", abort);
        searchControllers.delete(controller);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelSelection();
      for (const controller of searchControllers) controller.abort();
      searchControllers.clear();
    },
  };
}
