import { useEffect, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Save,
  WrapText,
} from "lucide-react";
import { backend, errorText, type EditorDraft } from "./bridge";
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

import {
  createEditorDraftPersistence,
  editorDraftOperations,
} from "./editorDraftPersistence";

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
  const [recovery, setRecovery] = useState<EditorDraft | null>(null);
  const [draftError, setDraftError] = useState("");
  const [draftStatus, setDraftStatus] = useState<"pending" | "stored" | "">("");
  const draftPersistence = useRef<ReturnType<
    typeof createEditorDraftPersistence
  > | null>(null);
  const [draftDeleteFailed, setDraftDeleteFailed] = useState(false);
  const [draftLoadFailed, setDraftLoadFailed] = useState(false);
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
  }, [dirty]);

  if (!draftPersistence.current) {
    draftPersistence.current = createEditorDraftPersistence({
      onPending: () => {
        if (alive.current) setDraftStatus("pending");
      },
      onStored: () => {
        if (alive.current) {
          setDraftStatus("stored");
          setDraftError("");
        }
      },
      onError: (e) => {
        if (alive.current) {
          setDraftStatus("");
          setDraftError(
            `本地草稿保存失败，退出或关机可能丢失修改：${errorText(e)}`,
          );
        }
      },
    });
  }

  function flushDraft() {
    void draftPersistence.current!.flush();
  }

  function scheduleDraft(value: string, baseline: RemoteTextFile) {
    if (!remote || session.demo || draftLoadFailed) return;
    draftPersistence.current!.schedule(() =>
      backend().UpdateEditorDraft(
        editorID.current,
        session.id,
        baseline,
        value,
      ),
    );
  }

  async function clearDraft(savedText?: string): Promise<boolean> {
    if (session.demo || !remote) return true;
    try {
      const cleared = await draftPersistence.current!.clear(
        () => backend().RemoveEditorDraft(session.id, document?.path || path),
        () => savedText === undefined || textRef.current === savedText,
      );
      if (!cleared) return false;
      if (alive.current) {
        setDraftStatus("");
        setDraftError("");
        setDraftDeleteFailed(false);
        setDraftLoadFailed(false);
      }
      return true;
    } catch (e) {
      if (alive.current) {
        setDraftDeleteFailed(true);
        setDraftError(`无法清除本地草稿，原草稿仍保留：${errorText(e)}`);
      }
      return false;
    }
  }

  useEffect(() => {
    // Native quit guards use SetEditorDirty. Do not add a webview unload prompt
    // that can block OS logout; flush best-effort without deleting the draft.
    const hide = () => {
      if (window.document.visibilityState === "hidden") flushDraft();
    };
    window.addEventListener("beforeunload", flushDraft);
    window.addEventListener("pagehide", flushDraft);
    window.document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("beforeunload", flushDraft);
      window.removeEventListener("pagehide", flushDraft);
      window.document.removeEventListener("visibilitychange", hide);
    };
  }, []);

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
      let draft: EditorDraft | null = null;
      if (remote && !session.demo) {
        try {
          draft = await editorDraftOperations.run(() =>
            backend().LoadEditorDraft(session.id, value.path),
          );
          if (alive.current && token === request.current) {
            setDraftError("");
            setDraftLoadFailed(false);
          }
        } catch (e) {
          if (alive.current && token === request.current) {
            // Do not overwrite an unreadable recovery copy with fresh edits.
            setDraftLoadFailed(true);
            setDraftError(
              `无法读取本地恢复草稿，原草稿已保留；请重试或明确丢弃草稿后编辑：${errorText(e)}`,
            );
          }
        }
      }
      if (alive.current && token === request.current) {
        setRecovery(draft);
        setDraftStatus("");
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
      // Unmount may mean shutdown or session navigation, not explicit discard.
      flushDraft();
      draftPersistence.current!.cancel();
      trackDirty(false);
    };
  }, [session.id, path, side]);

  async function save(): Promise<boolean> {
    if (
      !remote ||
      !document ||
      busy.current ||
      loading ||
      recovery ||
      draftLoadFailed
    )
      return false;
    if (textRef.current === document.text) return true;
    busy.current = true;
    setSaving(true);
    setError("");
    const submitted = textRef.current;
    const saveRequest = request.current;
    try {
      flushDraft();
      await editorDraftOperations.idle();
      const value = session.demo
        ? { ...document, text: submitted }
        : await backend().SaveRemoteTextFile(
            session.id,
            document.path,
            submitted,
            document.revision,
          );
      // A dialog may be reused for a different session/path during network IO.
      // Its new text must never be written to or cleared under the old identity.
      if (saveRequest !== request.current) return false;
      if (alive.current) {
        setDocument(value);
        if (value.text !== submitted && textRef.current === submitted) {
          textRef.current = value.text;
          setText(value.text);
          setGeneration((n) => n + 1);
        }
        setSaved(textRef.current === value.text);
        trackDirty(textRef.current !== value.text);
        onSaved();
      }
      // Input may arrive before React applies readOnly, or the dialog may unmount
      // during the network request. Never clear newer edits with an older save.
      if (textRef.current !== value.text) {
        scheduleDraft(textRef.current, value);
        flushDraft();
        return false;
      }
      // Keep a failed save's recovery copy. Only a successful remote save may
      // clear it, after queued writes have completed.
      const cleared = await clearDraft(value.text);
      if (textRef.current !== value.text) {
        scheduleDraft(textRef.current, value);
        flushDraft();
        return false;
      }
      return cleared;
    } catch (e) {
      if (alive.current && saveRequest === request.current)
        setError(errorText(e));
      return false;
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
    }
  }
  function requestClose() {
    if (busy.current) return;
    if (recovery || draftLoadFailed || (!dirty && draftDeleteFailed)) {
      // Closing the recovery prompt is not consent to delete its saved copy.
      // A broken disk/permissions must not trap the user in this dialog either.
      flushDraft();
      onClose();
      return;
    }
    if (confirmation) {
      setConfirmation(null);
      return;
    }
    if (dirty) setConfirmation("close");
    else void discardAndContinue("close");
  }
  async function discardAndContinue(action: "close" | "reload" | "recovery") {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      if (!(await clearDraft()) || !alive.current) return;
      setRecovery(null);
      setConfirmation(null);
      if (action === "close") onClose();
      else if (action === "reload") await load();
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
    }
  }

  function recoverDraft() {
    if (!recovery || !document || busy.current) return;
    // Keep the draft's original revision. Using today's remote revision here
    // would silently overwrite intervening changes on the next explicit save.
    const baseline = {
      ...document,
      revision: recovery.revision,
      lineEnding: recovery.lineEnding,
      bom: recovery.bom,
    };
    setDocument(baseline);
    setText(recovery.text);
    textRef.current = recovery.text;
    setRecovery(null);
    setGeneration((n) => n + 1);
    trackDirty(recovery.text !== document.text);
    if (recovery.revision !== document.revision)
      setError(
        "FILE_CHANGED|远程文件与草稿原版本不同。已恢复本地修改；保存时仍会检查冲突，请先比较或复制修改，避免丢失。",
      );
    scheduleDraft(recovery.text, baseline);
  }

  const saveAction = useRef(() => {});
  saveAction.current = () => {
    if (!confirmation && !recovery) void save();
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
            onChange={(value) => setLanguage(value as EditorLanguage | "auto")}
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
          disabled={loading || saving || !!confirmation || !!recovery}
          onClick={() =>
            dirty
              ? setConfirmation("reload")
              : void discardAndContinue("reload")
          }
          title="重新读取文件"
        >
          <RefreshCw size={14} aria-hidden="true" />
          重新载入
        </button>
        {remote && (
          <button
            className="button primary compact"
            disabled={
              !dirty || loading || saving || !!confirmation || !!recovery
            }
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
      {draftError && (
        <div className="text-editor-error" role="alert">
          <CircleAlert size={15} aria-hidden="true" />
          <span>{draftError}</span>
          {draftLoadFailed && (
            <>
              <button
                className="button secondary compact"
                disabled={saving || loading}
                onClick={() => void load()}
              >
                重试读取草稿
              </button>
              <button
                className="button secondary compact"
                disabled={saving || loading}
                onClick={() => void discardAndContinue("recovery")}
              >
                丢弃不可读草稿并编辑
              </button>
            </>
          )}
          {dirty && document && !draftLoadFailed && (
            <button
              className="button secondary compact"
              disabled={saving}
              onClick={() => {
                scheduleDraft(textRef.current, document);
                flushDraft();
              }}
            >
              重试草稿
            </button>
          )}
        </div>
      )}
      {recovery && (
        <div
          className="text-editor-confirm"
          role="alert"
          aria-label="恢复本地草稿"
        >
          <strong>发现此主机文件的本地草稿，是否恢复？</strong>
          <span>
            草稿保存于 {new Date(recovery.updatedAt).toLocaleString()}
            ，尚未上传到服务器。
            {recovery.revision !== document?.revision &&
              " 远程文件已变化；恢复后保存仍会检查版本冲突。"}
          </span>
          <div>
            <button
              className="button secondary compact"
              disabled={saving}
              onClick={() => void discardAndContinue("recovery")}
            >
              丢弃草稿，使用远程内容
            </button>
            <button
              className="button primary compact"
              disabled={saving}
              onClick={recoverDraft}
            >
              恢复草稿
            </button>
            <button
              className="button secondary compact"
              disabled={saving}
              onClick={onClose}
            >
              暂不恢复，保留草稿并关闭
            </button>
          </div>
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
          initialValue={textRef.current}
          language={actualLanguage}
          readOnly={
            !remote ||
            loading ||
            saving ||
            !!confirmation ||
            !!recovery ||
            draftLoadFailed
          }
          wrap={wrap}
          onChange={(value) => {
            textRef.current = value;
            setText(value);
            setSaved(false);
            // Notify the native manual-quit guard immediately, not after the
            // debounced filesystem write (or React's next effect).
            trackDirty(remote && value !== document.text);
            scheduleDraft(value, document);
          }}
          onSave={() => {
            if (!confirmation && !recovery) void save();
          }}
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
              disabled={saving}
              onClick={() => void discardAndContinue(confirmation)}
            >
              {confirmation === "close" ? "放弃修改" : "放弃并载入"}
            </button>
            {draftDeleteFailed && (
              <button
                className="button secondary compact"
                disabled={saving}
                onClick={() => {
                  flushDraft();
                  onClose();
                }}
              >
                保留本地草稿并关闭
              </button>
            )}
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
            session.demo ? (
              "未保存"
            ) : draftError ? (
              "未保存 · 本地恢复不可用"
            ) : draftStatus === "stored" ? (
              "未上传 · 本地草稿已保存"
            ) : (
              "未保存 · 本地草稿待写入"
            )
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
