import { useContext, useEffect, useRef } from "react";
import { AppContext, useAppDispatch, useAppSelector } from "gloomberb/react";
import type { AppConfig } from "gloomberb/types/config";
import type { GloomPluginContext } from "gloomberb/types/plugin";
import type { TickerRecord } from "gloomberb/types/ticker";
import { enableNativeNameColumns } from "./native-list-names";
import { resolveNativeNameDisplayMode, type NativeNameDisplayMode } from "./native-name-model";
import { mergeNativeName, type NativeNamePublication } from "./native-name-publication";
import { waitForNativeNameRetry } from "./native-name-retry";
import { resolveResearchListing } from "./research-symbols";

export interface NativeNameObserverProps {
  context: Pick<GloomPluginContext, "getConfig" | "paneSettings" | "log">;
  loadNames: (mode: NativeNameDisplayMode) => Promise<NativeNamePublication[]>;
  waitForRetry?: (signal: AbortSignal) => Promise<void>;
}

function memberFingerprint(tickers: ReadonlyMap<string, TickerRecord>, config: AppConfig): string {
  const portfolios = new Set(config.portfolios.map((item) => item.id));
  const watchlists = new Set(config.watchlists.map((item) => item.id));
  const members: string[][] = [];
  for (const ticker of tickers.values()) {
    const metadata = ticker.metadata;
    const listing = resolveResearchListing(metadata.ticker, metadata.exchange);
    if (!listing || listing.exchange === "BJSE" || !metadata.exchange || metadata.currency !== "CNY"
      || !["STK", "STOCK", "EQUITY", "COMMON STOCK"].includes(metadata.assetCategory?.toUpperCase() ?? "")) continue;
    const groups = [...new Set([
      ...metadata.portfolios.filter((id) => portfolios.has(id)).map((id) => `portfolio:${id}`),
      ...metadata.watchlists.filter((id) => watchlists.has(id)).map((id) => `watchlist:${id}`),
      ...metadata.positions.filter((position) => portfolios.has(position.portfolio)).map((position) => `portfolio:${position.portfolio}`),
    ])].sort();
    if (groups.length) members.push([metadata.ticker, listing.symbol, ...groups]);
  }
  // Names and position quantities are intentionally absent: applying a display
  // name or editing shares must not start another source lookup.
  return JSON.stringify(members.sort((left, right) => left[0]!.localeCompare(right[0]!)));
}

/** An invisible app-wide bridge; the native collection keeps its own renderer. */
export function NativeNameObserver({ context, loadNames, waitForRetry = waitForNativeNameRetry }: NativeNameObserverProps) {
  const dispatch = useAppDispatch();
  const app = useContext(AppContext);
  const tickers = useAppSelector((state) => state.tickers);
  const config = useAppSelector((state) => state.config);
  const latest = useRef({ tickers, config });
  latest.current = { tickers, config };
  const disabled = config.disabledPlugins?.includes("ashare-local") === true;
  const displayMode = resolveNativeNameDisplayMode(config);
  const members = memberFingerprint(tickers, config);
  const layout = JSON.stringify(config.layout.instances.filter((pane) => pane.paneId === "portfolio-list")
    .map((pane) => [pane.instanceId, pane.settings?.viewMode, pane.settings?.columnIds]));

  useEffect(() => {
    if (disabled) return;
    const controller = new AbortController();
    void enableNativeNameColumns(context, controller.signal).catch(() => {
      if (!controller.signal.aborted) context.log.warn("Native name column unavailable.");
    });
    return () => controller.abort();
  }, [context, layout, disabled]);

  useEffect(() => {
    if (disabled || members === "[]") return;
    const controller = new AbortController();
    const currentState = () => app && "getState" in app ? app.getState() : latest.current;
    const active = () => {
      const state = currentState();
      return !controller.signal.aborted && !state.config.disabledPlugins?.includes("ashare-local")
        && resolveNativeNameDisplayMode(state.config) === displayMode
        && memberFingerprint(state.tickers, state.config) === members;
    };
    const load = async (): Promise<NativeNamePublication[]> => {
      try { return await loadNames(displayMode); }
      catch {
        if (!active()) return [];
        context.log.warn("Native name RPC unavailable; retrying once.");
        try {
          await waitForRetry(controller.signal);
          if (!active()) return [];
          return await loadNames(displayMode);
        } catch {
          if (active()) context.log.warn("Native name RPC retry unavailable.");
          return [];
        }
      }
    };
    void load().then((names) => {
      if (!active()) return;
      for (const name of names) {
        // The public store can already contain a dispatched holding/name edit
        // before React renders again. Read it at publication, never replay a
        // ticker record from the backend response.
        const state = currentState();
        if (!active()) return;
        const current = state.tickers.get(name.symbol);
        const updated = current ? mergeNativeName(current, name, state.config) : null;
        if (updated) dispatch({ type: "UPDATE_TICKER", ticker: updated });
      }
    }).catch(() => {
      if (active()) context.log.warn("Native name publication unavailable.");
    });
    return () => controller.abort();
  }, [app, context, dispatch, loadNames, waitForRetry, members, disabled, displayMode]);

  return null;
}
