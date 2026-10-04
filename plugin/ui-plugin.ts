import type { GloomPlugin, GloomPluginContext } from "gloomberb/types/plugin";
import { createResearchSearchProvider, type ResearchSearchLoaders } from "./research-search";

export const pluginMetadata = {
  id: "ashare-local", name: "A-share Support", version: "0.9.0-alpha.1", toggleable: true,
  description: "Shanghai/Shenzhen Chinese and pinyin search, native add flows, and bilingual list names.",
  targets: ["cli", "tui", "desktop"], hosts: ["127.0.0.1", "www.cninfo.com.cn"],
  configSchema: [
    { key: "nameDisplay", label: "Name display / 名称显示", type: "select", required: false, defaultValue: "bilingual",
      options: [{ label: "Chinese + English / 中英文", value: "bilingual" }, { label: "Chinese / 中文", value: "chinese" }, { label: "English / 英文", value: "english" }],
      description: "Native Watchlist and Portfolio tables. Missing English falls back to verified Chinese." },
    { key: "pythonExecutable", label: "Python executable", type: "text", required: false,
      description: "Run scripts/setup-python.py first. Defaults to the plugin .venv; a custom executable must be an absolute path.", placeholder: "/absolute/path/to/python" },
  ],
} satisfies Partial<GloomPlugin>;

export function registerPluginSearch(ctx: GloomPluginContext, loaders: ResearchSearchLoaders = {}): () => void {
  const search = createResearchSearchProvider(ctx, loaders);
  const unregisterSearch = ctx.registerCommandBarSearchProvider(search);
  return () => { search.dispose(); unregisterSearch(); };
}
