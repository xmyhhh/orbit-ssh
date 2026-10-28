import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import {
  ArrowUpRight,
  Download,
  Github,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { backend, errorText, isDesktop, writeClipboard } from "../bridge";
import type { UpdateInfo } from "../bridge";
import { isAndroid } from "../android";
import { Modal } from "./Modal";
import { BrowserOpenURL } from "../../wailsjs/runtime/runtime";
import { appVersion, projectURL } from "../appInfo";

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  const pending = useRef(false);
  const canCheck = isDesktop() && !isAndroid();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function checkForUpdates() {
    if (!canCheck || pending.current) return;
    pending.current = true;
    setChecking(true);
    setError("");
    setUpdate(null);
    try {
      const result = await backend().CheckForUpdates(appVersion);
      if (alive.current) setUpdate(result);
    } catch (reason) {
      if (alive.current) setError(errorText(reason));
    } finally {
      pending.current = false;
      if (alive.current) setChecking(false);
    }
  }
  function openLink(event: MouseEvent<HTMLAnchorElement>) {
    if (isDesktop() && !isAndroid()) {
      event.preventDefault();
      BrowserOpenURL(event.currentTarget.href);
    }
  }
  const published = update?.publishedAt ? new Date(update.publishedAt) : null;
  return (
    <Modal title="关于 Orbit SSH" onClose={onClose} className="about-dialog">
      <div className="about-info">
        <div className="about-version-row">
          <span>当前版本</span>
          <strong>v{appVersion}</strong>
        </div>
        <a
          className="about-repository-link"
          href={projectURL}
          target="_blank"
          rel="noreferrer"
          onClick={openLink}
        >
          <Github size={17} aria-hidden="true" />
          <span>{projectURL.replace("https://", "")}</span>
          <ArrowUpRight size={15} aria-hidden="true" />
        </a>
        <p className="about-license">许可协议：The Unlicense</p>
      </div>
      <section className="about-updates" aria-label="版本更新">
        <div className="about-update-heading">
          <strong>版本更新</strong>
          {canCheck && (
            <button
              className="button secondary compact"
              disabled={checking}
              onClick={() => void checkForUpdates()}
            >
              {checking ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              {checking ? "正在检查…" : "检查更新"}
            </button>
          )}
        </div>
        <p className="about-update-hint">
          {canCheck
            ? "手动查询 GitHub 正式发布，检查结果缓存 5 分钟。"
            : isAndroid()
              ? "Android 版本单独发布，可复制发布页地址到浏览器查看。"
              : "请在桌面应用中检查更新，也可直接查看 GitHub 发布页。"}
        </p>
        {checking && (
          <p role="status" className="about-update-hint">
            正在获取 GitHub 版本信息…
          </p>
        )}
        {error && (
          <p role="alert" className="about-update-error">
            {error}
          </p>
        )}
        {update && (
          <div className="about-update-result">
            <p role="status" className="about-update-status">
              {update.status === "available"
                ? `发现新版本 v${update.latestVersion}`
                : update.status === "ahead"
                  ? `当前版本高于最新正式版 v${update.latestVersion}`
                  : `当前已是最新正式版 v${update.latestVersion}`}
            </p>
            {published && !Number.isNaN(published.getTime()) && (
              <p className="about-update-hint">
                发布于 {published.toLocaleDateString("zh-CN")}
              </p>
            )}
            <details
              className="about-release-notes"
              open={update.status === "available"}
            >
              <summary>发布说明</summary>
              <pre>
                {update.notes.trim() ||
                  "此版本未填写发布说明，可打开 GitHub 发布页查看。"}
              </pre>
            </details>
            {update.status === "available" && (
              <>
                <div className="about-update-downloads">
                  {update.downloads.map((download) => (
                    <a
                      className="button primary compact"
                      key={download.name}
                      href={download.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={openLink}
                    >
                      <Download size={14} />
                      {download.label}
                    </a>
                  ))}
                </div>
                <p className="about-update-hint">
                  {update.downloads.length
                    ? "点击后由浏览器下载，下载完成后退出 Orbit SSH，再安装或替换。"
                    : "此版本暂无匹配当前系统与架构的安装包，请在发布页查看。"}
                </p>
              </>
            )}
          </div>
        )}
        {isAndroid() ? (
          <button
            className="text-button"
            onClick={() => {
              void writeClipboard(`${projectURL}/releases`)
                .then(() => {
                  if (alive.current) setCopied(true);
                })
                .catch((reason) => {
                  if (alive.current) setError(errorText(reason));
                });
            }}
          >
            {copied ? "已复制发布页地址" : "复制 GitHub 发布页地址"}
          </button>
        ) : (
          <a
            className="about-release-link"
            href={update?.releaseUrl || `${projectURL}/releases`}
            target="_blank"
            rel="noreferrer"
            onClick={openLink}
          >
            打开 GitHub 发布页
            <ArrowUpRight size={14} />
          </a>
        )}
      </section>
      <div className="modal-footer">
        <button className="button primary" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
