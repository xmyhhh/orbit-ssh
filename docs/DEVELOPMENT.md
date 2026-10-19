# 开发与构建

Orbit SSH 使用 Wails v2、Go、React、TypeScript 和 xterm.js，桌面界面使用系统 WebView。面向使用者的下载和操作说明见 [README](../README.md)。

## 环境要求

- Go 1.24 或更新版本。
- Node.js 22.18 或更新版本及 npm（推荐 Node.js 24 LTS；前端测试使用内置 TypeScript 类型擦除）。
- 对应平台的 [Wails 构建依赖](https://wails.io/docs/gettingstarted/installation)。Windows 需要 WebView2；macOS 需要 Xcode Command Line Tools；Linux 需要 GTK / WebKitGTK 和可用的 Secret Service。需要 CGO 的构建环境还需 C 编译工具。

v1.0 的发布目标是 Windows x64。macOS、Linux 和其他架构需要在对应环境构建并验证。

Android ARM64 本地构建、安装与平台差异见 [Android 构建说明](ANDROID.md)。在 Windows 仓库根目录运行 `.\android\build.ps1` 可生成签名 APK。

## 本地开发

在仓库根目录运行：

```powershell
cd frontend
npm ci
npm run build
cd ..
go run github.com/wailsapp/wails/v2/cmd/wails@v2.11.0 dev
```

单独运行 `npm run dev` 可预览前端界面；网页预览使用独立 localStorage，不会连接桌面配置。SSH、SFTP、系统凭据、本地 Shell 和 WSL 功能需要桌面环境。

## 检查与测试

```powershell
cd frontend
npm test
npm run build
cd ..
go test ./...
go test -tags androidtest ./...
go vet ./...
```

Go 会嵌入 `frontend/dist`，请先完成前端构建，再执行 Go 检查，避免同时改写 dist。默认测试使用本地 SSH / SFTP 服务和模拟凭据库，不接触用户配置。

Windows 本地终端测试会通过真实 ConPTY 启动检测到的 PowerShell、CMD 和 PowerShell 7，验证独立会话、中文输出、用户主目录、尺寸调整与退出事件；不需要安装 WSL 发行版。本地 Shell 与 WSL 共用会话输入输出和关闭逻辑。

`npm test` 覆盖分屏几何、布局切换和关闭会话后的活动终端选择；`npm run test:layout` 可单独运行分屏测试。MCP 测试验证 HTTP / JSON-RPC 请求、令牌和来源校验、终端读取、历史检索与输入权限。`androidtest` 使用本地管道和模拟系统接口验证 Android 桥接，不需要模拟器或手机。

Windows 系统托盘通过 Win32 通知区域 API 实现，使用内嵌应用图标，不增加 CGo 依赖。托盘测试在有 Explorer 通知区域的会话中验证真实图标注册、菜单回调、任务栏恢复通知和退出清理；没有通知区域时跳过这项桌面集成测试。关闭行为测试覆盖保留会话和编辑内容、取消退出以及旧配置的默认迁移。

真实服务器监控测试需显式设置 `ORBIT_TEST_MONITOR_HOST` 为应用中已保存的主机名称或 ID，再运行：

```powershell
go test -run '^TestMonitorLiveHost$' -v
```

该测试使用已信任的指纹和已保存的凭据，只读采集两次，工作空间使用临时副本。

## Windows x64 发布构建

在仓库根目录运行统一构建入口：

```powershell
.\scripts\build-windows.ps1
# 自定义文件名；只接受文件名，输出目录固定为 build/bin
.\scripts\build-windows.ps1 -OutputName OrbitSSH-refactored.exe
```

默认产物为 `build/bin/OrbitSSH-windows-x64.exe`。脚本依次运行前端测试与构建、桌面及 Android 桥接 Go 测试、Go 静态检查，最后调用 Wails 编译。可用 `-WailsPath` 指定 CLI；否则优先使用已安装的 CLI、本地 `output/tools/wails.exe`，再使用仓库锁定的 Wails 版本。构建不会清理已有产物，也不会同步或整理 go.mod。生成的绑定、前端构建目录及可执行文件不提交到 Git；可执行文件作为 GitHub Release 附件上传。

发布标签使用 `v1.0`，npm 与 Wails 的产品版本使用 `1.0.0`，界面显示 `v1.0`。发布说明保存在 [docs/releases/v1.0.md](releases/v1.0.md)。

## 模块边界

| 位置 | 职责 |
| --- | --- |
| `frontend/src/App.tsx` | 组合页面、导航和操作入口。 |
| `frontend/src/hooks/` | 会话连接与回滚、终端布局、历史持久化及可刷新的异步数据。 |
| `frontend/src/TerminalCanvas.tsx`、`splitLayout.ts` | 保持终端挂载，绘制窗格与分隔线；纯布局算法独立测试。 |
| `frontend/src/dialogs/` | 对话框、表单与共用 Modal 焦点管理。 |
| `frontend/src/files/` | 目录状态、文件浏览交互、传输队列和路径工具；`FilesPane.tsx` 负责组合。 |
| `frontend/src/TerminalCatalog.tsx` | 本地 Shell 和 WSL 共用的卡片、刷新、加载、错误及空状态。 |
| `frontend/src/styles/` | 基础样式、应用外壳、主机页、终端、对话框、响应布局、监控和历史；`styles.css` 固定导入顺序。 |
| `terminal.go`、`terminal_output.go` | SSH 与本地终端共用的输入、尺寸、关闭 API，以及输出缓存和转发。 |
| `ssh.go`、`local.go`、`wsl*.go` | 各类连接的启动、平台实现与生命周期。 |
| `mcp_server.go`、`mcp_transport.go` | MCP 监听与状态、HTTP 和 JSON-RPC 协议。 |
| `mcp_tools.go`、`mcp_terminal.go`、`mcp_token.go` | MCP 工具、终端读取与检索、令牌持久化。 |
| `mobile_bridge.go`、`mobile_api.go`、`android/src/` | Android 管道协议、公开 API 白名单与系统接口，复用同一个 Go 后端。 |

公开的 `App` 方法同时供 Wails 和 Android 桥接使用；移动实现时保留签名、事件名称和数据格式。布局变化必须保持 `TerminalPane` 的会话 ID 和挂载状态，避免重复连接或丢失终端内容。样式入口按现有覆盖顺序加载，新增规则放到对应功能文件中。

## 数据与实现约定

配置位置：

| 系统 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\OrbitSSH\workspace.json` |
| macOS | `~/Library/Application Support/OrbitSSH/workspace.json` |
| Linux | `$XDG_CONFIG_HOME/OrbitSSH/workspace.json`，默认 `~/.config/OrbitSSH/workspace.json` |

密码和私钥口令分别通过 Windows 凭据管理器、macOS Keychain 或 Linux Secret Service 保存。配置 JSON 不包含这些凭据，私钥文件保留在原位置。

SFTP 传输先写入临时文件，成功后替换目标；取消时清理当前临时文件，已完成文件保留。递归传输跳过符号链接和特殊文件，已有传输目标是符号链接时拒绝写入，不支持断点续传。

远程文本编辑支持最大 2 MB 的 UTF-8 文件，本地只读预览最多显示前 256 KB。保存保留 BOM、LF / CRLF、Unix 权限与所有者，混合换行修改后统一为 LF。编辑符号链接时打开其实际目标并保留链接。保存前后核对内容版本，再重命名替换；SFTP 不提供跨程序版本锁，检测与替换之间仍有竞争窗口。原文件的 ACL、扩展属性及硬链接关系不复制到替换文件。
