import { getCapabilityStreamClient } from "gloomberb/capabilities";
import type { GloomPlugin, GloomPluginContext } from "gloomberb/types/plugin";
import { pluginMetadata, registerPluginSearch } from "./ui-plugin";
import { loadResearchIdentity, loadResearchSearch } from "./research-identity";
import { createDesktopResearchSearchClient } from "./research-search";
import { NativeNameObserver } from "./native-name-observer";
import type { NativeNamePublication } from "./native-name-publication";
import type { NativeNameDisplayMode } from "./native-name-model";

let desktopNameContext: GloomPluginContext | null = null;
let disposeResearchSearch: (() => void) | null = null;

async function loadNativeNamePublications(expectedDisplayMode: NativeNameDisplayMode): Promise<NativeNamePublication[]> {
  const runtime = getCapabilityStreamClient();
  if (!runtime) throw new Error("原生名称服务尚未准备好。");
  return (await runtime.invoke<{ names: NativeNamePublication[] }>("ashare-local.native-names", "sync", { expectedDisplayMode })).names;
}

const plugin: GloomPlugin = {
  ...pluginMetadata,
  slots: { "status:widget": () => desktopNameContext ? <NativeNameObserver context={desktopNameContext} loadNames={loadNativeNamePublications} /> : null },
  setup(ctx) {
    disposeResearchSearch?.();
    desktopNameContext = ctx;
    const client = createDesktopResearchSearchClient();
    disposeResearchSearch = registerPluginSearch(ctx, {
      searchLoad: (query, signal) => loadResearchSearch(query, signal, { client }),
      identityLoad: (symbol, signal) => loadResearchIdentity(symbol, signal, { client }),
    });
  },
  dispose() { disposeResearchSearch?.(); disposeResearchSearch = null; desktopNameContext = null; },
};
export default plugin;
