import { backend } from "./bridge";
import { useAsyncResource } from "./hooks/useAsyncResource";
import { TerminalCatalog, TerminalCatalogCard } from "./TerminalCatalog";
import type { TerminalCatalogLayoutProps } from "./TerminalCatalog";
import type { LocalShell, Session } from "./types";

const loadLocalShells = () => backend().GetLocalShellInfo();

export default function LocalShellPage({
  onOpen,
  sessions,
  ...layout
}: TerminalCatalogLayoutProps & {
  onOpen: (shell: LocalShell) => void;
  sessions: Session[];
}) {
  const {
    data: info,
    error,
    loading,
    refresh,
  } = useAsyncResource(loadLocalShells);
  return (
    <TerminalCatalog
      {...layout}
      title="本地 Shell"
      description="选择 Shell，在当前电脑的用户目录中打开终端。"
      loading={loading}
      error={error}
      onRefresh={refresh}
      count={info?.shells.length}
      loadingMessage="正在检测本地 Shell…"
      errorTitle="无法读取本地 Shell"
      emptyTitle="没有可用的本地 Shell"
      emptyMessage={
        info?.message || "安装 PowerShell 或 CMD 后，点击刷新重新检测。"
      }
    >
      {info?.shells.map((shell) => (
        <TerminalCatalogCard
          key={shell.id}
          name={shell.name}
          address={shell.path}
          description={
            shell.id === "cmd" ? "Windows 命令提示符" : "PowerShell 终端"
          }
          color={
            shell.id === "cmd"
              ? "mint"
              : shell.id === "pwsh"
                ? "violet"
                : "blue"
          }
          activeCount={
            sessions.filter(
              (session) =>
                session.localShell?.id === shell.id &&
                session.status !== "closed",
            ).length
          }
          running
          status="可用"
          onOpen={() => onOpen(shell)}
        />
      ))}
    </TerminalCatalog>
  );
}
