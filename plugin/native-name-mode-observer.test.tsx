import { expect, test } from "bun:test";
import { act } from "react";
import { AppContext, appReducer, createInitialState, createOpenTuiTestHarness, createStaticAppStore } from "gloomberb/test-support";
import { useAppSelector } from "gloomberb/react";
import { Box, Text } from "gloomberb/ui";
import { createDefaultConfig } from "gloomberb/types/config";
import type { TickerRecord } from "gloomberb/types/ticker";
import { NATIVE_NAME_PROVENANCE_KEY, formatNativeName,
  type NativeNameDisplayMode, type NativeNameProvenanceV1, type NativeNameProvenanceV2 } from "./native-list-names";
import { NativeNameObserver, type NativeNameObserverProps } from "./native-name-observer";
import type { NativeNamePublication } from "./native-name-publication";

// Public AppStore plus the actual host reducer, with no profile or network I/O.
const tui = createOpenTuiTestHarness({ width: 100, height: 10 });
type AppState = ReturnType<typeof createInitialState>;
type AppAction = Parameters<typeof appReducer>[1];
const chineseName = "腾远钴业", englishName = "Ganzhou Tengyuan Cobalt Co., Ltd.", observedAt = "2026-10-04T09:00:00Z";
const previous: NativeNameProvenanceV1 = {
  schemaVersion: 1, managedBy: "ashare-local", symbol: "301219.SZ", code: "301219", exchange: "SZSE", orgId: "fixture-issuer",
  previousName: englishName, appliedName: chineseName, appliedAt: observedAt, ownershipBasis: "cloud_search", providerEvidence: null,
  source: { provider: "cninfo", sourceURL: "https://www.cninfo.com.cn/new/information/topSearch/query?keyWord=301219&maxNum=10",
    receivedAt: observedAt, sha256: "a".repeat(64), sourceVersion: null },
};
function publication(mode: NativeNameDisplayMode, english: string | null = englishName): NativeNamePublication {
  const name = formatNativeName(chineseName, english, mode);
  const provenance: NativeNameProvenanceV2 = { ...previous, schemaVersion: 2, chineseName, englishName: english, displayMode: mode,
    appliedName: name, englishNameEvidence: english ? { providerId: "gloomberb-cloud", symbol: "301219", exchange: "SZSE",
      currency: "CNY", name: english, instrumentType: "EQUITY", observedAt } : null };
  return { symbol: "301219", name, provenance };
}
function fixture(mode?: NativeNameDisplayMode) {
  const config = createDefaultConfig(new URL("./mode-observer-memory-profile", import.meta.url).pathname);
  config.portfolios = [{ id: "main", name: "Main Portfolio", currency: "CNY" }];
  config.watchlists = [{ id: "watch", name: "Watchlist" }]; config.layout.instances = [];
  if (mode) config.pluginConfig["ashare-local"] = { nameDisplay: mode };
  let state = createInitialState(config);
  const ticker: TickerRecord = { metadata: { ticker: "301219", name: chineseName, exchange: "SZSE", currency: "CNY", assetCategory: "Common Stock",
    portfolios: ["main"], watchlists: [], positions: [{ portfolio: "main", shares: 123, avgCost: 4, broker: "manual" }],
    broker_contracts: [], tags: ["original"], custom: { untouched: 1, [NATIVE_NAME_PROVENANCE_KEY]: structuredClone(previous) } } };
  state.tickers = new Map([["301219", ticker]]);
  const listeners = new Set<() => void>(), actions: AppAction[] = [], warnings: string[] = [];
  const store = { ...createStaticAppStore(state), getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispatch(action: AppAction) { actions.push(action); state = appReducer(state, action); for (const listener of listeners) listener(); },
  };
  const context: NativeNameObserverProps["context"] = { getConfig: () => state.config,
    paneSettings: { get: () => null, set: async () => {}, delete: async () => {} },
    log: { debug() {}, info() {}, warn(message) { warnings.push(String(message)); }, error() {} },
  };
  const edit = (change: (record: TickerRecord) => void) => {
    const current = structuredClone(state.tickers.get("301219")!); change(current); store.dispatch({ type: "UPDATE_TICKER", ticker: current });
  };
  const configEdit = (change: (config: AppState["config"]) => void) => {
    const current = structuredClone(state.config); change(current); store.dispatch({ type: "SET_CONFIG", config: current });
  };
  const setMode = (mode: NativeNameDisplayMode) => configEdit(value => { value.pluginConfig["ashare-local"] = { nameDisplay: mode }; });
  return { store, context, actions, warnings, edit, configEdit, setMode };
}
function retryGate() {
  const pending = Promise.withResolvers<void>(), signals: AbortSignal[] = [];
  // Resolve even after abort to exercise the observer's own late-response guard.
  return { signals, release: () => pending.resolve(), wait: (signal: AbortSignal) => { signals.push(signal); return pending.promise; } };
}
function NameRead() {
  const name = useAppSelector(state => state.tickers.get("301219")?.metadata.name ?? "missing");
  return <Box height={1}><Text>{name}</Text></Box>;
}
function Harness({ f, loadNames, gate, observer = true }: {
  f: ReturnType<typeof fixture>; loadNames: NativeNameObserverProps["loadNames"]; gate: ReturnType<typeof retryGate>; observer?: boolean;
}) {
  return <AppContext value={f.store}>{observer ? <NativeNameObserver context={f.context} loadNames={loadNames} waitForRetry={gate.wait} /> : null}<NameRead /></AppContext>;
}
async function render(f: ReturnType<typeof fixture>, loadNames: NativeNameObserverProps["loadNames"], gate: ReturnType<typeof retryGate>, observer = true) {
  await act(async () => { await tui.render(<Harness f={f} loadNames={loadNames} gate={gate} observer={observer} />); });
}
function record(f: ReturnType<typeof fixture>) { return f.store.getState().tickers.get("301219")!; }

test("legacy renderer names migrate by default and each display-mode transition starts exactly one public load", async () => {
  const f = fixture(), gate = retryGate(), loaded: NativeNameDisplayMode[] = [];
  const loadNames = async (mode: NativeNameDisplayMode) => { loaded.push(mode); return [publication(mode)]; };
  await render(f, loadNames, gate); await tui.waitForFrameToContain(`${chineseName} · ${englishName}`);
  expect(record(f).metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ schemaVersion: 2, displayMode: "bilingual" });
  for (const mode of ["chinese", "english", "bilingual"] as const) {
    await act(async () => { f.setMode(mode); }); await tui.waitForFrameToContain(publication(mode).name);
    expect(record(f).metadata.name).toBe(publication(mode).name);
  }
  await act(async () => { f.edit(value => { value.metadata.positions[0]!.shares = 789; value.metadata.tags = ["edited"]; }); });
  await tui.renderFrames(2);
  expect(loaded).toEqual(["bilingual", "chinese", "english", "bilingual"]);
  expect(record(f).metadata.positions[0]!.shares).toBe(789);
});

test("a late old-mode response cannot replace the name published by the current mode", async () => {
  const f = fixture(), gate = retryGate(), old = Promise.withResolvers<NativeNamePublication[]>(); let calls = 0;
  const loadNames = () => { calls++; return calls === 1 ? old.promise : Promise.resolve([publication("english")]); };
  await render(f, loadNames, gate);
  await act(async () => { f.setMode("english"); }); await tui.waitForFrameToContain(englishName);
  await act(async () => { old.resolve([publication("bilingual")]); }); await tui.renderFrames(2);
  expect(record(f).metadata.name).toBe(englishName); expect(calls).toBe(2);
  expect(f.actions.filter(action => action.type === "UPDATE_TICKER")).toHaveLength(1);
});

test("a mode response merges fresh holdings and preserves a custom name edited while the request was pending", async () => {
  for (const customName of [false, true]) {
    const f = fixture(), gate = retryGate(), pending = Promise.withResolvers<NativeNamePublication[]>(); let calls = 0;
    const loadNames = () => { calls++; return calls === 1 ? Promise.resolve([publication("bilingual")]) : pending.promise; };
    await render(f, loadNames, gate); await tui.waitForFrameToContain(`${chineseName} · ${englishName}`);
    await act(async () => { f.setMode("english"); });
    await act(async () => { f.edit(value => {
      value.metadata.positions[0]!.shares = 789; value.metadata.tags = ["edited"]; value.metadata.custom.untouched = 2;
      if (customName) value.metadata.name = "我的持仓标签";
    }); pending.resolve([publication("english")]); });
    await tui.waitForFrameToContain(customName ? "我的持仓标签" : englishName);
    const saved = record(f);
    expect(saved.metadata.name).toBe(customName ? "我的持仓标签" : englishName);
    expect(saved.metadata.positions[0]!.shares).toBe(789); expect(saved.metadata.tags).toEqual(["edited"]);
    expect(saved.metadata.custom.untouched).toBe(2); expect(calls).toBe(2);
  }
});

test("disable, observer disposal, and removal from collections reject a pending publication", async () => {
  for (const mode of ["disable", "dispose", "leave-collections"]) {
    const f = fixture(), gate = retryGate(), pending = Promise.withResolvers<NativeNamePublication[]>(); let calls = 0;
    const loadNames = () => { calls++; return pending.promise; };
    await render(f, loadNames, gate);
    if (mode === "dispose") await render(f, loadNames, gate, false);
    else await act(async () => {
      if (mode === "disable") f.configEdit(value => { value.disabledPlugins = ["ashare-local"]; });
      else f.edit(value => { value.metadata.portfolios = []; value.metadata.positions = []; });
    });
    const actionsBefore = f.actions.length;
    await act(async () => { pending.resolve([publication("bilingual")]); }); await tui.renderFrames(2);
    expect(record(f).metadata.name).toBe(chineseName); expect(f.actions).toHaveLength(actionsBefore); expect(calls).toBe(1);
  }
});

test("membership changes cancel the old pass while the new pass can publish into the current collection", async () => {
  const f = fixture(), gate = retryGate(), old = Promise.withResolvers<NativeNamePublication[]>(); let calls = 0;
  const loadNames = () => { calls++; return calls === 1 ? old.promise : Promise.resolve([publication("bilingual")]); };
  await render(f, loadNames, gate);
  await act(async () => { f.edit(value => { value.metadata.watchlists = ["watch"]; }); });
  await tui.waitForFrameToContain(`${chineseName} · ${englishName}`);
  await act(async () => { old.resolve([publication("bilingual", "Older Verified Provider Name")]); }); await tui.renderFrames(2);
  expect(record(f).metadata.name).toBe(`${chineseName} · ${englishName}`);
  expect(record(f).metadata.watchlists).toEqual(["watch"]); expect(calls).toBe(2);
});

test("a frontend mode saved before the backend commits retries once with the captured mode and then publishes", async () => {
  const f = fixture(), gate = retryGate(), loaded: NativeNameDisplayMode[] = [];
  let committedMode: NativeNameDisplayMode = "bilingual";
  const loadNames = async (mode: NativeNameDisplayMode) => {
    loaded.push(mode); if (mode !== committedMode) throw new Error("backend mode commit pending"); return [publication(mode)];
  };
  await render(f, loadNames, gate); await tui.waitForFrameToContain(`${chineseName} · ${englishName}`);
  await act(async () => { f.setMode("english"); });
  expect(record(f).metadata.name).toBe(`${chineseName} · ${englishName}`);
  expect(gate.signals).toHaveLength(1); expect(loaded).toEqual(["bilingual", "english"]);
  await act(async () => { committedMode = "english"; gate.release(); }); await tui.waitForFrameToContain(englishName);
  await tui.renderFrames(3);
  expect(loaded).toEqual(["bilingual", "english", "english"]);
  expect(record(f).metadata.name).toBe(englishName); expect(f.warnings).toHaveLength(1);
});

test("a second mode change cancels the old mode waiting for backend commit without reviving its retry", async () => {
  const f = fixture(), gate = retryGate(), loaded: NativeNameDisplayMode[] = [];
  let committedMode: NativeNameDisplayMode = "bilingual";
  const loadNames = async (mode: NativeNameDisplayMode) => {
    loaded.push(mode); if (mode !== committedMode) throw new Error("backend mode commit pending"); return [publication(mode)];
  };
  await render(f, loadNames, gate); await tui.waitForFrameToContain(`${chineseName} · ${englishName}`);
  await act(async () => { f.setMode("english"); }); expect(gate.signals).toHaveLength(1);
  await act(async () => { committedMode = "chinese"; f.setMode("chinese"); }); await tui.waitForFrameToContain(chineseName);
  expect(gate.signals[0]?.aborted).toBeTrue();
  await act(async () => { gate.release(); }); await tui.renderFrames(2);
  expect(loaded).toEqual(["bilingual", "english", "chinese"]);
  expect(record(f).metadata.name).toBe(chineseName); expect(f.warnings).toHaveLength(1);
});

test("English mode without verified English evidence still displays Chinese after legacy migration", async () => {
  const f = fixture("english"), gate = retryGate();
  await render(f, async () => [publication("english", null)], gate); await tui.renderFrames(2);
  expect(record(f).metadata.name).toBe(chineseName);
  expect(record(f).metadata.custom[NATIVE_NAME_PROVENANCE_KEY]).toMatchObject({ schemaVersion: 2, displayMode: "english", englishName: null });
  expect(f.actions.filter(action => action.type === "UPDATE_TICKER")).toHaveLength(1);
});
