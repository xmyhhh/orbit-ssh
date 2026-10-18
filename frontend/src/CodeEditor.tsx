import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { loadEditorLanguage, type EditorLanguage } from "./editorLanguages";

const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.modifier, tags.operatorKeyword],
    color: "var(--code-keyword)",
  },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: "var(--code-string)",
  },
  {
    tag: [tags.number, tags.bool, tags.null, tags.atom],
    color: "var(--code-number)",
  },
  {
    tag: [tags.comment, tags.meta],
    color: "var(--code-comment)",
    fontStyle: "italic",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--code-function)",
  },
  {
    tag: [tags.typeName, tags.className, tags.tagName, tags.heading],
    color: "var(--code-type)",
  },
  {
    tag: [
      tags.propertyName,
      tags.attributeName,
      tags.definition(tags.variableName),
    ],
    color: "var(--code-property)",
  },
  {
    tag: tags.link,
    color: "var(--code-function)",
    textDecoration: "underline",
  },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.invalid, color: "var(--danger)" },
]);

export default function CodeEditor({
  initialValue,
  language,
  readOnly,
  wrap,
  onChange,
  onSave,
  onPosition,
}: {
  initialValue: string;
  language: EditorLanguage;
  readOnly: boolean;
  wrap: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  onPosition: (line: number, column: number) => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave, onPosition });
  callbacks.current = { onChange, onSave, onPosition };
  const compartments = useRef({
    language: new Compartment(),
    editable: new Compartment(),
    wrap: new Compartment(),
    theme: new Compartment(),
  });
  useEffect(() => {
    const c = compartments.current;
    const theme = () =>
      EditorView.theme(
        {},
        { dark: document.documentElement.dataset.theme === "dark" },
      );
    const editor = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          lineNumbers(),
          foldGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          highlightSelectionMatches(),
          search({ top: true }),
          syntaxHighlighting(highlight),
          c.language.of([]),
          c.editable.of(EditorState.readOnly.of(readOnly)),
          c.wrap.of(wrap ? EditorView.lineWrapping : []),
          c.theme.of(theme()),
          EditorView.contentAttributes.of({
            "aria-label": "文件内容",
            spellcheck: "false",
          }),
          EditorState.phrases.of({
            Find: "查找",
            Replace: "替换",
            next: "下一个",
            previous: "上一个",
            all: "全选匹配",
            "match case": "区分大小写",
            regexp: "正则",
            "by word": "全词",
            replace: "替换",
            "replace all": "全部替换",
            close: "关闭查找",
            "Go to line": "跳转到行",
            go: "跳转",
            "Fold line": "折叠行",
            "Unfold line": "展开行",
            "folded code": "已折叠代码",
            unfold: "展开",
          }),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...foldKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) {
              const position = update.state.selection.main.head;
              const line = update.state.doc.lineAt(position);
              callbacks.current.onPosition(
                line.number,
                position - line.from + 1,
              );
            }
          }),
        ],
      }),
    });
    view.current = editor;
    const observer = new MutationObserver(() =>
      editor.dispatch({ effects: c.theme.reconfigure(theme()) }),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const focus = requestAnimationFrame(() => editor.focus());
    return () => {
      cancelAnimationFrame(focus);
      observer.disconnect();
      editor.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void loadEditorLanguage(language).then((extension) => {
      if (!cancelled)
        view.current?.dispatch({
          effects: compartments.current.language.reconfigure(extension),
        });
    });
    return () => {
      cancelled = true;
    };
  }, [language]);
  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.editable.reconfigure(
        EditorState.readOnly.of(readOnly),
      ),
    });
    if (!readOnly) view.current?.focus();
  }, [readOnly]);
  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.wrap.reconfigure(
        wrap ? EditorView.lineWrapping : [],
      ),
    });
  }, [wrap]);
  return <div className="text-code-editor" ref={parent} />;
}
