import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  CircleAlert,
  ListChecks,
  Upload,
  X,
} from "lucide-react";
import type { Transfer } from "../types";
import { finished, size, statusText } from "./fileUtils";

export default function TransferQueue({
  transfers,
  open,
  onToggle,
  onClear,
  onCancel,
}: {
  transfers: Transfer[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
  onCancel: (id: string) => void;
}) {
  const active = transfers.filter((job) => !finished(job)).length;
  return (
    <section
      className={`transfer-queue ${open ? "expanded" : ""}`}
      aria-label="传输队列"
    >
      <div className="transfer-queue-heading">
        <button aria-expanded={open} onClick={onToggle}>
          <ChevronDown
            size={15}
            className={open ? "" : "collapsed"}
            aria-hidden="true"
          />
          <ListChecks size={16} aria-hidden="true" />
          <strong>传输队列</strong>
          <span>
            {active ? `${active} 个进行中` : `${transfers.length} 条记录`}
          </span>
        </button>
        {transfers.some(finished) && (
          <button className="queue-clear" onClick={onClear}>
            清除已结束
          </button>
        )}
      </div>
      {open &&
        (transfers.length ? (
          <div className="transfer-queue-list">
            {[...transfers].reverse().map((job) => {
              const percent =
                job.status === "completed"
                  ? 100
                  : job.totalBytes
                    ? Math.min(
                        100,
                        Math.round((job.doneBytes / job.totalBytes) * 100),
                      )
                    : 0;
              const seconds =
                ((job.finishedAt || Date.now()) - job.startedAt) / 1000;
              const speed =
                job.startedAt && seconds > 0 && !finished(job)
                  ? size(Math.max(0, job.doneBytes) / Math.max(1, seconds)) +
                    "/s"
                  : "";
              return (
                <div className={`transfer-job ${job.status}`} key={job.id}>
                  <div className="transfer-direction">
                    {job.direction === "upload" ? (
                      <Upload size={16} aria-label="上传" />
                    ) : (
                      <ArrowDownToLine size={16} aria-label="下载" />
                    )}
                  </div>
                  <div className="transfer-job-main">
                    <div>
                      <strong title={job.name}>{job.name}</strong>
                      <span className="transfer-job-state">
                        {statusText[job.status]}
                        {job.status === "running" && ` ${percent}%`}
                        {job.skipped > 0 && ` · 跳过 ${job.skipped} 项`}
                      </span>
                    </div>
                    <div className="transfer-job-detail">
                      <span title={job.error || job.current || job.destination}>
                        {job.error ||
                          (job.current
                            ? job.current.replace(/^.*[\\/]/, "") + " → "
                            : "") + job.destination}
                      </span>
                      <span>
                        {size(job.doneBytes)} / {size(job.totalBytes)}
                        {speed && ` · ${speed}`}
                      </span>
                    </div>
                    <progress
                      aria-label={`${job.name} 传输进度`}
                      value={percent}
                      max={100}
                    />
                  </div>
                  {!finished(job) ? (
                    <button
                      className="icon-button"
                      title="取消此传输"
                      aria-label={`取消传输 ${job.name}`}
                      disabled={job.status === "cancelling"}
                      onClick={() => onCancel(job.id)}
                    >
                      <X size={15} />
                    </button>
                  ) : job.status === "completed" ? (
                    <Check
                      className="job-complete"
                      size={17}
                      aria-hidden="true"
                    />
                  ) : job.status === "failed" ? (
                    <CircleAlert
                      className="job-failed"
                      size={17}
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="job-end" />
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="transfer-queue-empty">暂无传输</div>
        ))}
    </section>
  );
}
