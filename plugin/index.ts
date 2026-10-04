import { join } from "node:path";
import { createElement } from "react";
import type { GloomPlugin, GloomPluginContext } from "gloomberb/types/plugin";
import { bridgeClient, BridgeError } from "./client";
import { createBridgeRuntime, type BridgeRuntime } from "./bridge-runtime";
import { pluginMetadata, registerPluginSearch } from "./ui-plugin";
import { createNativeNameLifecycle } from "./native-list-names";
import { nativeNamePublication } from "./native-name-publication";
import { NativeNameObserver } from "./native-name-observer";
import { resolveNativeNameDisplayMode, type NativeNameDisplayMode } from "./native-name-model";

let context: GloomPluginContext | null = null;
let runtime: BridgeRuntime | null = null;
let runtimeConfig: string | null = null;
let nativeNames: ReturnType<typeof createNativeNameLifecycle> | null = null;
let disposeResearchSearch: (() => void) | null = null;

async function loadNativeNamePublications(expectedDisplayMode?: NativeNameDisplayMode) {
  const owner = context;
  if (!owner || owner.getConfig().disabledPlugins?.includes("ashare-local") || !nativeNames) throw new Error("A 股插件尚未启用。");
  const current = () => {
    if (context !== owner || owner.getConfig().disabledPlugins?.includes("ashare-local")) throw new Error("名称服务已退出。");
    // Desktop dispatches its view preference before persisting the backend
    // config. Do not report an old-mode sync as success in that window.
    if (expectedDisplayMode && resolveNativeNameDisplayMode(owner.getConfig()) !== expectedDisplayMode)
      throw new BridgeError("NAME_CONFIG_PENDING", "名称显示设置尚未同步，稍后补试。");
  };
  current();
  await nativeNames.sync();
  current();
  const tickers = await owner.tickerRepository.loadAllTickers();
  current();
  return tickers.flatMap((ticker) => {
    const name = nativeNamePublication(ticker);
    return name && (!expectedDisplayMode || (name.provenance.schemaVersion === 2 && name.provenance.displayMode === expectedDisplayMode)) ? [name] : [];
  });
}

function service(): BridgeRuntime {
  if (!context) throw new BridgeError("NOT_INITIALIZED", "A 股插件尚未初始化。");
  const config = context.getConfig();
  if (config.disabledPlugins?.includes("ashare-local")) {
    runtime?.dispose(); runtime = null; runtimeConfig = null;
    throw new BridgeError("PLUGIN_DISABLED", "A 股插件已停用。");
  }
  // CLI pane discovery supplies a read-only configState with no stored values.
  const configuredPython = context.configState.get<string>("pythonExecutable")
    ?? config.pluginConfig?.["ashare-local"]?.pythonExecutable;
  if (configuredPython != null && typeof configuredPython !== "string") {
    throw new BridgeError("INVALID_CONFIG", "Python 可执行文件必须是绝对路径文本。");
  }
  const pythonPath = configuredPython?.trim() || undefined;
  const runtimeDir = join(config.dataDir, "runtime", "ashare-local");
  const key = JSON.stringify([pythonPath, runtimeDir]);
  if (runtime && runtimeConfig === key) return runtime;
  runtime?.dispose();
  runtime = null;
  runtime = createBridgeRuntime({
    pythonPath, runtimeDir, log: context.log,
  });
  runtimeConfig = key;
  return runtime;
}
bridgeClient.setBaseUrl(() => service().ensureStarted());

const plugin: GloomPlugin = {
  ...pluginMetadata,
  slots: { "status:widget": () => context ? createElement(NativeNameObserver, { context, loadNames: loadNativeNamePublications }) : null },
  capabilities: [{
    id: "ashare-local.native-names", kind: "plugin-service", name: "Native A-share display names",
    operations: { sync: { kind: "action", rendererSafe: true, async handler(input: unknown, ctx) {
      if (!context || context.getConfig().disabledPlugins?.includes("ashare-local") || !nativeNames) throw new Error("A 股插件尚未启用。");
      ctx.signal?.throwIfAborted();
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new BridgeError("INVALID_REQUEST", "名称同步参数无效。");
      const { expectedDisplayMode } = input as { expectedDisplayMode?: unknown };
      if (expectedDisplayMode !== undefined && !["bilingual", "chinese", "english"].includes(expectedDisplayMode as string))
        throw new BridgeError("INVALID_REQUEST", "名称显示选项无效。");
      const names = await loadNativeNamePublications(expectedDisplayMode as NativeNameDisplayMode | undefined);
      ctx.signal?.throwIfAborted();
      // Only display names cross the renderer bridge; positions stay in their current owner.
      return { names };
    } } },
  }, {
    id: "ashare-local.bridge", kind: "plugin-service", name: "A-share local service transport",
    operations: { request: { kind: "query", rendererSafe: true, async handler(input: unknown, ctx) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new BridgeError("INVALID_REQUEST", "Invalid bridge query");
      const { path, params } = input as { path?: unknown; params?: unknown };
      if (typeof path !== "string" || !params || typeof params !== "object" || Array.isArray(params)
        || Object.values(params).some((value) => typeof value !== "string")) throw new BridgeError("INVALID_REQUEST", "Invalid bridge query");
      return bridgeClient.request(path, params as Record<string, string>, ctx.signal);
    } } },
  }],
  setup(ctx) {
    disposeResearchSearch?.();
    nativeNames?.shutdown();
    runtime?.dispose();
    runtime = null;
    runtimeConfig = null;
    context = ctx;
    disposeResearchSearch = registerPluginSearch(ctx);
    nativeNames = createNativeNameLifecycle(ctx);
    void nativeNames.ready.catch(() => {});
  },
  dispose() {
    disposeResearchSearch?.();
    disposeResearchSearch = null;
    nativeNames?.shutdown();
    nativeNames = null;
    context = null;
    runtime?.dispose();
    runtime = null;
    runtimeConfig = null;
  },
};
export default plugin;
