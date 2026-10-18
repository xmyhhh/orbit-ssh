import catalog from "./data/snippets.json";
import type { Snippet, Workspace } from "./types";

export const snippetCategories = [
  "系统",
  "磁盘与文件",
  "进程",
  "网络",
  "日志与服务",
  "Docker",
  "Git",
  "自定义",
];
export const builtinSnippets: Snippet[] = catalog.snippets;
export const snippetCatalogVersion = catalog.version;
const legacyIDs = new Set(["system", "disk", "process"]);
const builtinCategories = new Map(
  builtinSnippets.map((snippet) => [snippet.id, snippet.category]),
);
export const snippetCategory = (snippet: Snippet) =>
  snippet.category || builtinCategories.get(snippet.id) || "自定义";

export function upgradeSnippetCatalog(workspace: Workspace): Workspace {
  if ((workspace.snippetCatalogVersion ?? 0) >= catalog.version)
    return workspace;
  const ids = new Set(workspace.snippets.map((snippet) => snippet.id));
  const commands = new Set(
    workspace.snippets.map((snippet) => snippet.command),
  );
  return {
    ...workspace,
    snippetCatalogVersion: catalog.version,
    snippets: [
      ...workspace.snippets,
      ...builtinSnippets.filter(
        (snippet) =>
          !legacyIDs.has(snippet.id) &&
          !ids.has(snippet.id) &&
          !commands.has(snippet.command),
      ),
    ],
  };
}
