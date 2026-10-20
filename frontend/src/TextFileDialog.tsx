import { useEffect, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Save,
  WrapText,
} from "lucide-react";
import { backend, errorText } from "./bridge";
import { Modal } from "./dialogs/Modal";
import CodeEditor from "./CodeEditor";
import {
  detectLanguage,
  editorLanguages,
  type EditorLanguage,
} from "./editorLanguages";
import type { RemoteTextFile, Session } from "./types";
import { Select } from "./ui/Select";
import "./editor.css";

export default function TextFileDialog({
  session,
  side,
  name,
  path,
  onClose,
  onSaved,
}: {
  session: Session;
  side: "local" | "remote";
  name: string;
  path: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const remote = side === "remote";
  const [document, setDocument] = useState<RemoteTextFile | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [language, setLanguage] = useState<EditorLanguage | "auto">("auto");
  const [wrap, setWrap] = useState(false);
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const [confirmation, setConfirmation] = useState<"close" | "reload" | null>(
    null,
  );
  const [saved, setSaved] = useState(false);
  const request = useRef(0);
  const alive = useRef(true);
  const busy = useRef(false);
  const textRef = useRef("");
  const editorID = useRef(crypto.randomUUID());
  const dirtyQueue = useRef(Promise.resolve());
  const dirty = remote && document !== null && text !== document.text;
  const detected = detectLanguage(path, document?.text || "");
  const actualLanguage = language === "auto" ? detected : language;
  const conflict = error.includes("FILE_CHANGED|");

  function trackDirty(value: boolean) {
    if (session.demo) return;
    dirtyQueue.current = dirtyQueue.current
      .then(() => backend().SetEditorDirty(editorID.current, value))
      .catch(() => {
        /* A closed native bridge cannot receive close guards. */
      });
  }
  useEffect(() => {
    trackDirty(dirty);
    function beforeUnload(event: BeforeUnloadEvent) {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  async function load() {
    const token = ++request.current;
    setLoading(true);
    setError("");
    try {
      let value: RemoteTextFile;
      let partial = false;
      if (session.demo) {
        value = {
          path,
          revision: "demo",
          lineEnding: "LF",
          bom: false,
          text: name.endsWith(".json")
            ? '{\n  "name": "Orbit SSH",\n  "mode": "preview"\n}\n'
            : "# Orbit SSH\n\n这是远程文本编辑示例。\n",
        };
      } else if (remote) {
        value = await backend().ReadRemoteTextFile(session.id, path);
      } else {
        const preview = await backend().ReadFilePreview(session.id, side, path);
        partial = preview.truncated;
        value = {
          path,
          text: preview.text,
          revision: "",
          lineEnding: "LF",
          bom: false,
        };
      }
      if (alive.current && token === request.current) {
        setDocument(value);
        setText(value.text);
        textRef.current = value.text;
        setTruncated(partial);
        setSaved(false);
        setGeneration((n) => n + 1);
        setPosition({ line: 1, column: 1 });
      }
    } catch (e) {
      if (alive.current && token === request.current) setError(errorText(e));
    } finally {
      if (alive.current && token === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      request.current++;
      trackDirty(false);
    };
  }, [session.id, path, side]);

  async function save(): Promise<boolean> {
    if (!remote || !document || busy.current || loading) return false;
    if (textRef.current === document.text) return true;
    busy.current = true;
    setSaving(true);
    setError("");
    const submitted = textRef.current;
    try {
      const value = session.demo
        ? { ...document, text: submitted }
        : await backend().SaveRemoteTextFile(
            session.id,
            document.path,
            submitted,
            document.revision,
          );
      if (alive.current) {
        setDocument(value);
        if (value.text !== submitted) {
          textRef.current = value.text;
          setText(value.text);
          setGeneration((n) => n + 1);
        }
        setSaved(true);
        onSaved();
      }
      return true;
    } catch (e) {
      if (alive.current) setError(errorText(e));
      return false;
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
    }
  }
  function requestClose() {
    if (busy.current) return;
    if (confirmation) {
      setConfirmation(null);
      return;
    }
    if (dirty) setConfirmation("close");
    else onClose();
  }
  const saveAction = useRef(() => {});
  saveAction.current = () => {
    if (!confirmation) void save();
  };
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        saveAction.current();
      }
    }
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  return (
    <Modal
      title={`${dirty ? "● " : ""}${name}`}
      eyebrow={`${remote ? "远程编辑" : "本地预览 · 只读"}${session.demo ? " · 演示" : ""}`}
      className="text-file-dialog"
      onClose={requestClose}
    >
      <div className="text-file-path" title={document?.path || path}>
        {document?.path || path}
      </div>
      <div className="text-editor-toolbar">
        <div className="text-editor-toolbar-field">
          <span>语法</span>
          <Select
            ariaLabel="语法高亮"
            size="md"
            className="text-editor-language-select"
            value={language}
            onChange={(value) =>
              setLanguage(value as EditorLanguage | "auto")
            }
            options={[
              {
                value: "auto",
                label: `自动 · ${editorLanguages.find(([id]) => id === detected)?.[1]}`,
              },
              ...editorLanguages.map(([id, label]) => ({
                value: id,
                label,
              })),
            ]}
          />
        </div>
        <button
          className={`icon-button ${wrap ? "active" : ""}`}
          aria-label="自动换行"
          title="自动换行"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          <WrapText size={17} />
        </button>
        <div className="text-editor-toolbar-spacer" />
        <button
          className="button secondary compact"
          disabled={loading || saving || !!confirmation}
          onClick={() => (dirty ? setConfirmation("reload") : void load())}
          title="重新读取文件"
        >
          <RefreshCw size={14} aria-hidden="true" />
          重新载入
        </button>
        {remote && (
          <button
            className="button primary compact"
            disabled={!dirty || loading || saving || !!confirmation}
            onClick={() => void save()}
            title="保存到服务器（Ctrl / ⌘ S）"
          >
            {saving ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Save size={14} />
            )}{" "}
            {saving ? "保存中…" : "保存"}
          </button>
        )}
      </div>
      {error && (
        <div className="text-editor-error" role="alert">
          <CircleAlert size={15} aria-hidden="true" />
          <span>{error.replace("FILE_CHANGED|", "")}</span>
          {conflict && (
            <button
              className="button secondary compact"
              disabled={loading || saving}
              onClick={() => setConfirmation("reload")}
            >
              重新载入
            </button>
          )}
        </div>
      )}
      {loading ? (
        <div className="text-editor-loading">
          <LoaderCircle className="spin" size={24} />
          正在读取…
        </div>
      ) : document ? (
        <CodeEditor
          key={generation}
          initialValue={document.text}
          language={actualLanguage}
          readOnly={!remote || saving || !!confirmation}
          wrap={wrap}
          onChange={(value) => {
            textRef.current = value;
            setText(value);
            setSaved(false);
          }}
          onSave={() => void save()}
          onPosition={(line, column) => setPosition({ line, column })}
        />
      ) : (
        <div className="text-editor-loading">无法打开此文件</div>
      )}
      {confirmation && (
        <div
          className="text-editor-confirm"
          role="alert"
          aria-label="未保存的修改"
        >
          <strong>
            {confirmation === "close"
              ? "关闭前保存修改？"
              : "重新载入会丢失当前修改"}
          </strong>
          <div>
            <button
              className="button secondary compact"
              autoFocus
              onClick={() => setConfirmation(null)}
            >
              继续编辑
            </button>
            <button
              className="button secondary compact"
              onClick={() => {
                const action = confirmation;
                setConfirmation(null);
                if (action === "close") onClose();
                else void load();
              }}
            >
              {confirmation === "close" ? "放弃修改" : "放弃并载入"}
            </button>
            {confirmation === "close" && (
              <button
                className="button primary compact"
                onClick={() => {
                  setConfirmation(null);
                  void save().then((ok) => {
                    if (ok && alive.current) onClose();
                  });
                }}
              >
                保存并关闭
              </button>
            )}
          </div>
        </div>
      )}
      <div className="text-editor-status">
        <span role="status" aria-live="polite">
          {dirty ? (
            "未保存"
          ) : saved ? (
            <>
              <Check size={12} />
              {session.demo ? "演示已保存" : "已保存到服务器"}
            </>
          ) : remote ? (
            "可编辑"
          ) : (
            "只读"
          )}
          {truncated && " · 前 256 KB"}
        </span>
        <span>
          行 {position.line}，列 {position.column}
        </span>
        <span>
          UTF-8{document?.bom ? " BOM" : ""} ·{" "}
          {document?.lineEnding === "mixed"
            ? "混合（保存为 LF）"
            : document?.lineEnding || "LF"}
        </span>
        <span className="text-editor-shortcuts">
          Ctrl / ⌘ F 查找{remote ? " · S 保存" : ""}
        </span>
      </div>
    </Modal>
  );
}
