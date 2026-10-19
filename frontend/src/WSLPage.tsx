import { backend } from "./bridge";
import { useAsyncResource } from "./hooks/useAsyncResource";
import { TerminalCatalog, TerminalCatalogCard } from "./TerminalCatalog";
import type { TerminalCatalogLayoutProps } from "./TerminalCatalog";
import type { Session } from "./types";

const loadWSL = () => backend().GetWSLInfo();

export default function WSLPage({
  onOpen,
  sessions,
  ...layout
}: TerminalCatalogLayoutProps & {
  onOpen: (distribution: string) => void;
  sessions: Session[];
}) {
  const { data: info, error, loading, refresh } = useAsyncResource(loadWSL);
  return (
    <TerminalCatalog
      {...layout}
      title="WSL"
      description="选择已安装的 Linux 发行版，直接打开本地终端。"
      loading={loading}
      error={error}
      onRefresh={refresh}
      count={info?.distributions.length}
      loadingMessage="正在检测 WSL 发行版…"
      errorTitle="无法读取 WSL 发行版"
      emptyTitle={info?.installed ? "没有可用的发行版" : "尚未安装 WSL"}
      emptyMessage={
        info?.message || "在 PowerShell 中运行 wsl --install，安装后点击刷新。"
      }
    >
      {info?.distributions.map((distribution) => {
        const activeCount = sessions.filter(
          (session) =>
            session.wslDistribution === distribution.name &&
            session.status !== "closed",
        ).length;
        const running = distribution.running || activeCount > 0;
        return (
          <TerminalCatalogCard
            key={distribution.name}
            name={distribution.name}
            address={`WSL · ${distribution.name}`}
            description="Linux 发行版"
            color={running ? "mint" : "blue"}
            activeCount={activeCount}
            running={running}
            status={distribution.running ? "运行中" : "未运行"}
            onOpen={() => onOpen(distribution.name)}
          />
        );
      })}
    </TerminalCatalog>
  );
}
