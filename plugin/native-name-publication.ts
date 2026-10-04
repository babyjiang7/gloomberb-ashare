import type { AppConfig } from "gloomberb/types/config";
import type { TickerRecord } from "gloomberb/types/ticker";
import { NATIVE_NAME_PROVENANCE_KEY, type NativeNameProvenance } from "./native-list-names";
import { parseNativeNameProvenance, resolveNativeNameDisplayMode } from "./native-name-model";
import { resolveResearchListing } from "./research-symbols";

export interface NativeNamePublication {
  symbol: string;
  name: string;
  provenance: NativeNameProvenance;
}

export function nativeNamePublication(ticker: TickerRecord): NativeNamePublication | null {
  const value = parseNativeNameProvenance(ticker.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]);
  const listing = resolveResearchListing(ticker.metadata.ticker, ticker.metadata.exchange);
  if (!value || listing?.symbol !== value.symbol || listing.code !== value.code || listing.exchange !== value.exchange
    || value.appliedName !== ticker.metadata.name) return null;
  return { symbol: ticker.metadata.ticker, name: ticker.metadata.name, provenance: value };
}

/** Update only display metadata in the current view, never replay a saved position. */
export function mergeNativeName(current: TickerRecord | null | undefined, value: NativeNamePublication, config: AppConfig): TickerRecord | null {
    const provenance = parseNativeNameProvenance(value?.provenance);
    if (!current || !provenance || config.disabledPlugins?.includes("ashare-local") || current.metadata.ticker !== value.symbol
      || value.name !== provenance.appliedName
      || (provenance.schemaVersion === 2 && provenance.displayMode !== resolveNativeNameDisplayMode(config))) return null;
    const listing = resolveResearchListing(current.metadata.ticker, current.metadata.exchange);
    if (!listing || listing.exchange === "BJSE" || listing.symbol !== value.provenance.symbol || listing.code !== value.provenance.code
      || listing.exchange !== value.provenance.exchange || current.metadata.currency !== "CNY"
      || !["STK", "STOCK", "EQUITY", "COMMON STOCK"].includes(current.metadata.assetCategory?.toUpperCase() ?? "")) return null;
    const portfolios = new Set(config.portfolios.map((item) => item.id)), watchlists = new Set(config.watchlists.map((item) => item.id));
    if (!current.metadata.portfolios.some((id) => portfolios.has(id)) && !current.metadata.watchlists.some((id) => watchlists.has(id))
      && !current.metadata.positions.some((position) => portfolios.has(position.portfolio))) return null;
    const previous = parseNativeNameProvenance(current.metadata.custom[NATIVE_NAME_PROVENANCE_KEY]);
    const identity = current.metadata.custom.ashareChineseIdentity as { orgId?: unknown; symbol?: unknown } | undefined;
    if (identity && ((typeof identity.orgId === "string" && identity.orgId !== provenance.orgId)
      || (typeof identity.symbol === "string" && resolveResearchListing(identity.symbol)?.symbol !== provenance.symbol))) return null;
    if (previous && (previous.orgId !== provenance.orgId || previous.symbol !== provenance.symbol
      || previous.code !== provenance.code || previous.exchange !== provenance.exchange)) return null;
    const owned = previous?.orgId === provenance.orgId && previous.symbol === provenance.symbol
      && previous.appliedName === current.metadata.name;
    if (current.metadata.name !== value.provenance.previousName && !owned) return null;
    // A same-name v1 -> v2 migration still publishes the separate language
    // evidence. Only an entirely identical name/certificate is a no-op.
    if (current.metadata.name === value.name && JSON.stringify(previous) === JSON.stringify(provenance)) return null;
    return { ...current, metadata: { ...current.metadata, name: value.name,
      custom: { ...current.metadata.custom, [NATIVE_NAME_PROVENANCE_KEY]: provenance } } };
}
