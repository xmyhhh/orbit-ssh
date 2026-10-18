import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

export const editorLanguages = [
  ["text", "纯文本"],
  ["shell", "Shell"],
  ["json", "JSON"],
  ["yaml", "YAML"],
  ["nginx", "Nginx"],
  ["python", "Python"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["html", "HTML"],
  ["css", "CSS"],
  ["sql", "SQL"],
  ["markdown", "Markdown"],
  ["xml", "XML"],
  ["properties", "INI / 配置"],
  ["toml", "TOML"],
  ["dockerfile", "Dockerfile"],
  ["go", "Go"],
  ["rust", "Rust"],
  ["cpp", "C / C++"],
  ["java", "Java"],
] as const;
export type EditorLanguage = (typeof editorLanguages)[number][0];

export function detectLanguage(filename: string, text: string): EditorLanguage {
  const name = filename.split(/[\\/]/).pop()?.toLowerCase() || "";
  const ext = name.split(".").pop() || "";
  if (/^dockerfile(?:\.|$)/.test(name)) return "dockerfile";
  if (
    name === "nginx.conf" ||
    /[\\/]nginx[\\/]/i.test(filename) ||
    (ext === "conf" && /\b(?:server|http|upstream|location)\s*\{/.test(text))
  )
    return "nginx";
  if (
    /^\.(?:bash|zsh|profile)/.test(name) ||
    /^\.env(?:\.|$)/.test(name) ||
    /^(?:sh|bash|zsh|fish)$/.test(ext) ||
    /^#!.*\b(?:ba|z|k)?sh\b/.test(text)
  )
    return "shell";
  if (ext === "py" || /^#!.*\bpython/.test(text)) return "python";
  const byExtension: Record<string, EditorLanguage> = {
    json: "json",
    jsonc: "javascript",
    yaml: "yaml",
    yml: "yaml",
    py: "python",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    html: "html",
    htm: "html",
    css: "css",
    sql: "sql",
    md: "markdown",
    markdown: "markdown",
    xml: "xml",
    svg: "xml",
    ini: "properties",
    conf: "properties",
    cfg: "properties",
    properties: "properties",
    service: "properties",
    socket: "properties",
    timer: "properties",
    toml: "toml",
    go: "go",
    rs: "rust",
    c: "cpp",
    h: "cpp",
    cc: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    java: "java",
  };
  return byExtension[ext] || "text";
}

// Parsers are bundled locally and loaded only when a file needs that language.
export async function loadEditorLanguage(
  language: EditorLanguage,
): Promise<Extension> {
  switch (language) {
    case "shell":
      return StreamLanguage.define(
        (await import("@codemirror/legacy-modes/mode/shell")).shell,
      );
    case "nginx":
      return StreamLanguage.define(
        (await import("@codemirror/legacy-modes/mode/nginx")).nginx,
      );
    case "dockerfile":
      return StreamLanguage.define(
        (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile,
      );
    case "properties":
      return StreamLanguage.define(
        (await import("@codemirror/legacy-modes/mode/properties")).properties,
      );
    case "toml":
      return StreamLanguage.define(
        (await import("@codemirror/legacy-modes/mode/toml")).toml,
      );
    case "go":
      return StreamLanguage.define(
        (await import("@codemirror/legacy-modes/mode/go")).go,
      );
    case "rust":
      return StreamLanguage.define(
        (await import("@codemirror/legacy-modes/mode/rust")).rust,
      );
    case "cpp":
      return StreamLanguage.define(
        (await import("@codemirror/legacy-modes/mode/clike")).cpp,
      );
    case "java":
      return StreamLanguage.define(
        (await import("@codemirror/legacy-modes/mode/clike")).java,
      );
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript({
        jsx: true,
      });
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
        jsx: true,
      });
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "xml":
      return (await import("@codemirror/lang-xml")).xml();
    default:
      return [];
  }
}
