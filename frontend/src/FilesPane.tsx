import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  Server,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { backend, errorText, listen } from "./bridge";
import { isAndroid } from "./android";
import { Modal } from "./dialogs/Modal";
import type { RemoteFile, Session, Transfer } from "./types";
import FileBrowser from "./files/FileBrowser";
import TransferQueue from "./files/TransferQueue";
import { child, finished } from "./files/fileUtils";
import type { Side } from "./files/fileUtils";
import { useDirectory } from "./files/useDirectory";
import { Select } from "./ui/Select";

const TextFileDialog = lazy(() => import("./TextFileDialog"));

export default function FilesPane({
  session,
  onClose,
  notify,
}: {
  session: Session;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const local = useDirectory(session, "local");
  const remote = useDirectory(session, "remote");
  const [conflict, setConflict] = useState<"skip" | "replace">("skip");
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [queueOpen, setQueueOpen] = useState(true);
  const [enqueueing, setEnqueueing] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const retryPending = useRef(false);
  const [androidFileSide, setAndroidFileSide] = useState<Side>("remote");
  const [preview, setPreview] = useState<{
    name: string;
    side: Side;
    path: string;
  } | null>(null);
  const alive = useRef(true);
  const sequence = useRef(0);
  async function refreshJobs() {
    if (session.demo) return;
    const current = ++sequence.current;
    try {
      const jobs = await backend().ListTransfers(session.id);
      if (alive.current && current === sequence.current) setTransfers(jobs);
    } catch (e) {
      if (alive.current) notify(errorText(e));
    }
  }
  const refreshPaths = useRef(() => {});
  refreshPaths.current = () => {
    void local.load(local.latest.current.path);
    void remote.load(remote.latest.current.path);
  };
  useEffect(() => {
    alive.current = true;
    void refreshJobs();
    const off = session.demo
      ? () => {}
      : listen(`sftp:transfer:${session.id}`, (value) => {
          if (!alive.current) return;
          sequence.current++;
          const job = value as Transfer;
          setTransfers((items) =>
            items.some((t) => t.id === job.id)
              ? items.map((t) => (t.id === job.id ? job : t))
              : [...items, job],
          );
          if (finished(job)) refreshPaths.current();
        });
    const timer = session.demo
      ? undefined
      : setInterval(() => {
          void refreshJobs();
        }, 1500);
    return () => {
      alive.current = false;
      sequence.current++;
      off();
      clearInterval(timer);
    };
  }, [session.id]);
  async function enqueue(direction: "upload" | "download") {
    const source = direction === "upload" ? local : remote;
    const target = direction === "upload" ? remote : local;
    if (!source.selected.length) return;
    setEnqueueing(true);
    try {
      await backend().QueueTransfer({
        sessionId: session.id,
        direction,
        sources: source.selected.map((name) =>
          child(
            source.directory.path,
            name,
            direction === "upload" ? "local" : "remote",
          ),
        ),
        destination: target.directory.path,
        conflict,
      });
      source.setSelected([]);
      setQueueOpen(true);
      await refreshJobs();
    } catch (e) {
      notify(errorText(e));
    } finally {
      if (alive.current) setEnqueueing(false);
    }
  }
  function openPreview(side: Side, file: RemoteFile, filename: string) {
    setPreview({ name: file.name, side, path: filename });
  }
  async function retryTransfer(id: string) {
    if (retryPending.current || session.demo || session.status !== "connected")
      return;
    retryPending.current = true;
    setRetrying(id);
    try {
      await backend().RetryTransfer(id);
      if (alive.current) {
        setQueueOpen(true);
        await refreshJobs();
      }
    } catch (e) {
      if (alive.current) notify(errorText(e));
    } finally {
      retryPending.current = false;
      if (alive.current) setRetrying(null);
    }
  }
  const canTransfer =
    !session.demo &&
    session.status === "connected" &&
    !enqueueing &&
    !local.busy &&
    !remote.busy &&
    Boolean(local.directory.path && remote.directory.path) &&
    local.directory.path !== "::drives";
  return (
    <section className="file-workspace" aria-label="文件管理器">
      <div className="file-workspace-heading">
        <div>
          <FolderOpen size={19} aria-hidden="true" />
          <strong>文件管理</strong>
          <span className="tag neutral">SFTP</span>
          {session.demo && <span className="tag neutral">演示数据</span>}
        </div>
        <button className="button secondary compact" onClick={onClose}>
          <ArrowLeft size={14} aria-hidden="true" />
          返回终端
        </button>
      </div>
      <div className="transfer-toolbar">
        <div>
          <button
            className="button primary compact"
            disabled={!canTransfer || !local.selected.length}
            onClick={() => void enqueue("upload")}
            title={
              isAndroid()
                ? "上传本地所选项目到远程当前目录"
                : "上传左侧所选项目到右侧当前目录"
            }
          >
            <Upload size={14} aria-hidden="true" />
            上传{local.selected.length > 0 && ` (${local.selected.length})`}
            <ArrowRight size={13} aria-hidden="true" />
          </button>
          <button
            className="button secondary compact"
            disabled={!canTransfer || !remote.selected.length}
            onClick={() => void enqueue("download")}
            title={
              isAndroid()
                ? "下载远程所选项目到本地当前目录"
                : "下载右侧所选项目到左侧当前目录"
            }
          >
            <ArrowLeft size={13} aria-hidden="true" />
            <ArrowDownToLine size={14} aria-hidden="true" />
            下载{remote.selected.length > 0 && ` (${remote.selected.length})`}
          </button>
        </div>
        <div className="transfer-field">
          <span>同名文件</span>
          <Select
            ariaLabel="同名文件处理方式"
            size="sm"
            className="transfer-select"
            value={conflict}
            onChange={(value) => setConflict(value as "skip" | "replace")}
            options={[
              { value: "skip", label: "跳过" },
              { value: "replace", label: "替换" },
            ]}
          />
        </div>
      </div>
      {session.status !== "connected" && (
        <div role="status" className="file-connection-message">
          连接已断开，重新连接后可继续浏览和传输。
        </div>
      )}
      {isAndroid() && (
        <div className="android-file-tabs" role="tablist" aria-label="文件位置">
          <button
            role="tab"
            aria-selected={androidFileSide === "local"}
            onClick={() => setAndroidFileSide("local")}
          >
            <HardDrive size={15} /> 本地文件
            {local.selected.length > 0 && ` (${local.selected.length})`}
          </button>
          <button
            role="tab"
            aria-selected={androidFileSide === "remote"}
            onClick={() => setAndroidFileSide("remote")}
          >
            <Server size={15} /> 远程文件
            {remote.selected.length > 0 && ` (${remote.selected.length})`}
          </button>
        </div>
      )}
      <div className={`file-browsers android-file-side-${androidFileSide}`}>
        <FileBrowser
          side="local"
          state={local}
          session={session}
          onPreview={(...args) => void openPreview(...args)}
        />
        <FileBrowser
          side="remote"
          state={remote}
          session={session}
          onPreview={(...args) => void openPreview(...args)}
        />
      </div>
      <TransferQueue
        transfers={transfers}
        open={queueOpen}
        canRetry={!session.demo && session.status === "connected"}
        retrying={retrying}
        onRetry={(id) => void retryTransfer(id)}
        onToggle={() => setQueueOpen(!queueOpen)}
        onClear={() => {
          void backend()
            .ClearTransfers(session.id)
            .then(refreshJobs)
            .catch((e) => notify(errorText(e)));
        }}
        onCancel={(id) => {
          void backend()
            .CancelTransfer(id)
            .then(refreshJobs)
            .catch((e) => notify(errorText(e)));
        }}
      />
      <div className="file-workspace-status">
        <span>
          <ShieldCheck size={12} aria-hidden="true" />
          {session.demo ? "演示模式" : "SFTP"}
        </span>
        <span>
          {isAndroid()
            ? "点文件名打开 · 勾选后传输"
            : "双击打开 · Ctrl / Shift 多选"}
        </span>
      </div>
      {preview && (
        <Suspense
          fallback={
            <Modal title={preview.name} onClose={() => setPreview(null)}>
              <div className="browser-empty">
                <LoaderCircle className="spin" size={22} />
                正在打开…
              </div>
            </Modal>
          }
        >
          <TextFileDialog
            session={session}
            {...preview}
            onClose={() => setPreview(null)}
            onSaved={() => void remote.load(remote.latest.current.path)}
          />
        </Suspense>
      )}
    </section>
  );
}
