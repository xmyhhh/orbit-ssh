# 开发与构建

Orbit SSH 使用 Wails v2、Go、React、TypeScript 和 xterm.js，桌面界面使用系统 WebView。面向使用者的下载和操作说明见 [README](../README.md)。

## 环境要求

- Go 1.24 或更新版本。
- Node.js 22.18 或更新版本及 npm（推荐 Node.js 24 LTS；前端测试使用内置 TypeScript 类型擦除）。
- 对应平台的 [Wails 构建依赖](https://wails.io/docs/gettingstarted/installation)。Windows 需要 WebView2；macOS 需要 Xcode Command Line Tools；Linux 需要 GTK / WebKitGTK 和可用的 Secret Service。需要 CGO 的构建环境还需 C 编译工具。

Wails v2.11 的绑定生成器使用较旧的 `golang.org/x/tools`，无法读取 Go 1.25 及更高版本的导出数据，会报 `internal error: package "context" without types was imported from "orbitssh"`。使用 Go 1.24 构建本项目；如需更新 Wails 再一并验证。

v3.1 的发布目标是 Windows x64、macOS 和 Linux x64，Android 版仍为 v2.0。macOS 的构建入口见 [macOS 构建](#macos-构建)。

Android ARM64 本地构建、安装与平台差异见 [Android 构建说明](ANDROID.md)。在 Windows 仓库根目录运行 `.\android\build.ps1` 可生成签名 APK。

## 本地开发

Go 源码放在 `src/` 下，仓库根目录只保留 Wails 需要的入口文件：`main.go` 内嵌前端资源并启动 `src/app`，`main_mobile.go` 是 Android 后端的入口。`src/app` 承载 `App` 结构体和全部对外方法，`src/platform`、`src/local`、`src/tray`、`src/sshagent`、`src/mcp` 和 `src/mobile` 提供各平台与各功能的实现。Wails 绑定的方法必须和 `App` 结构体在同一个包里，所以新增对外方法要放在 `src/app`。

在仓库根目录运行：

```bash
cd frontend
npm ci
cd ..
# 首次构建需要先生成 Wails 前端绑定，否则 tsc 找不到 frontend/wailsjs
mkdir -p frontend/dist && touch frontend/dist/gitkeep
go run github.com/wailsapp/wails/v2/cmd/wails@v2.11.0 generate module
cd frontend
npm run build
cd ..
go run github.com/wailsapp/wails/v2/cmd/wails@v2.11.0 dev
```

`frontend/wailsjs` 由 Wails CLI 生成，不提交到 Git；`go run ... wails dev` 也会自动生成，只需在单独执行 `npm run build` 前先生成一次。

单独运行 `npm run dev` 可预览前端界面；网页预览使用独立 localStorage，不会连接桌面配置。SSH、SFTP、系统凭据、本地 Shell 和 WSL 功能需要桌面环境。

## 检查与测试

```bash
cd frontend
npm test
npm run build
cd ..
go test ./...
go test -tags androidtest ./...
go vet ./...
```

Go 会嵌入 `frontend/dist`，请先完成前端构建，再执行 Go 检查，避免同时改写 dist。默认测试使用本地 SSH / SFTP 服务和模拟凭据库，不接触用户配置。

并发改动后建议再跑一次 `go test -race ./...` 和 `go test -race -tags androidtest ./...`，会话心跳等后台协程不会直接读取 `App` 上的可替换字段。

Windows 本地终端测试会通过真实 ConPTY 启动检测到的 PowerShell、CMD 和 PowerShell 7，验证独立会话、中文输出、用户主目录、尺寸调整与退出事件；不需要安装 WSL 发行版。本地 Shell 与 WSL 共用会话输入输出和关闭逻辑。

`npm test` 覆盖分屏几何、布局切换和关闭会话后的活动终端选择；`npm run test:layout` 可单独运行分屏测试。MCP 测试验证 HTTP / JSON-RPC 请求、令牌和来源校验、主机配置、连接创建与取消、主机指纹、共用终端、历史检索及独立权限；接入测试在临时目录中验证六种客户端的 TOML / JSON / JSONC 合并、HTTP 连接格式、注释保留、备份、重复接入、目录覆盖、命令行确认及多客户端部分失败，不接触用户的客户端配置。`androidtest` 使用本地管道和模拟系统接口验证 Android 桥接，不需要模拟器或手机。

Windows 系统托盘通过 Win32 通知区域 API 实现，使用内嵌应用图标，不增加 CGo 依赖。托盘测试在有 Explorer 通知区域的会话中验证真实图标注册、菜单回调、任务栏恢复通知和退出清理；没有通知区域时跳过这项桌面集成测试。关闭行为测试覆盖保留会话和编辑内容、取消退出以及旧配置的默认迁移。

真实服务器监控测试需显式设置 `ORBIT_TEST_MONITOR_HOST` 为应用中已保存的主机名称或 ID，再运行：

```powershell
go test -run '^TestMonitorLiveHost$' -v
```

该测试使用已信任的指纹和已保存的凭据，只读采集两次，工作空间使用临时副本。

## Windows x64 发布构建

在仓库根目录运行构建入口。如果 PowerShell 禁止执行脚本，请在命令前加上 `powershell -NoProfile -ExecutionPolicy Bypass -File`：

```powershell
# 只生成可执行文件
.\scripts\build-windows.ps1

# 生成便携版和安装版
.\scripts\package-windows.ps1 -ReleaseLabel v3.1
```

`build-windows.ps1` 默认输出 `build/bin/OrbitSSH-windows-x64.exe`，也可用 `-OutputName` 修改文件名（只接受文件名，输出目录固定为 `build/bin`）。脚本依次运行前端测试与构建、桌面及 Android 桥接 Go 测试、Go 静态检查，最后调用 Wails 编译。可用 `-WailsPath` 指定 CLI；否则优先使用已安装的 CLI、本地 `output/tools/wails.exe`，再使用仓库锁定的 Wails 版本。构建不会清理已有产物，也不会同步或整理 go.mod。

`package-windows.ps1` 会先调用同一构建入口（可用 `-SkipBuild` 复用 `build/bin/OrbitSSH.exe`），然后在 `output/release` 生成：

- `OrbitSSH-v3.1-windows-x64-portable.zip`：便携版，解压后直接运行 `OrbitSSH.exe`，压缩包内附 `LICENSE.txt` 和 `README.txt`。
- `OrbitSSH-v3.1-windows-x64-setup.exe`：安装版，按当前用户安装，默认目录为 `%LOCALAPPDATA%\Programs\Orbit SSH`。
- `SHA256SUMS.txt`：上述文件的 SHA-256 校验值。

安装版重复运行时会关闭正在运行的 Orbit SSH、卸载旧版本并覆盖安装，不会删除 `%APPDATA%\OrbitSSH` 中的主机配置、凭据和终端历史。安装包内置 Microsoft Edge WebView2 引导程序，检测到运行库缺失时会尝试静默安装。首次打包会自动下载固定版本的 NSIS 3.13 到 `output/tools` 并校验 SHA-256；也可用 `-NsisPath` 指定 `makensis.exe`。`-PortableOnly` / `-InstallerOnly` 可只生成一种包，`-OutputDirectory` 可修改输出目录，`-ReleaseLabel` 控制文件名中的版本标签；构建 Android 后可传 `-ExtraArtifact .\OrbitSSH-v2.0-android-arm64.apk`，把 APK 一并写入 `SHA256SUMS.txt`。
生成的绑定、前端构建目录及二进制产物不提交到 Git；`output/` 下的发布文件作为 GitHub Release 附件上传。

发布标签使用 `v3.1`，npm 与 Wails 的产品版本使用 `3.1.0`，界面显示 `v3.1`，Android 仍为 `versionName="2.0"`、`versionCode="6"`。发布说明保存在 [docs/releases/v3.1.md](releases/v3.1.md)。

Windows 构建通过后可复用同一份前端资源生成 Android 包：

```powershell
.\android\build.ps1 -SkipFrontend
```

发布附件为 `OrbitSSH-v3.1-windows-x64-setup.exe`、`OrbitSSH-v3.1-windows-x64-portable.zip`、`OrbitSSH-v2.0-android-arm64.apk` 和 `SHA256SUMS.txt`。APK 使用既有 `android/orbit-local.keystore` 签名，保留该文件以便后续覆盖升级；密钥和二进制产物均不提交到 Git。

## macOS 构建

在 macOS 上构建需要 Go 1.24 或更新版本、Node.js 22.18 或更新版本，以及 Xcode Command Line Tools。Wails CLI 通过 `go install github.com/wailsapp/wails/v2/cmd/wails@v2.11.0` 安装。

在仓库根目录运行：

```bash
# 构建 build/bin/Orbit SSH.app
./scripts/build-macos.sh

# Apple Silicon 与 Intel 通用二进制，并打包为可分发 zip
./scripts/build-macos.sh --platform darwin/universal --package
```

脚本依次生成缺失的 Wails 前端绑定、运行前端测试与构建、桌面及 Android 桥接 Go 测试、Go 静态检查，最后调用 Wails 编译并签名。可用 `--platform` 指定构建目标（`darwin/arm64`、`darwin/amd64`、`darwin/universal`），用 `--sign-identity` 指定签名身份（默认 `-` 为临时签名，传入 `none` 可跳过签名），用 `--output-name` 修改 App 内可执行文件名，用 `--skip-frontend` 复用已有的 `frontend/dist` 和 `frontend/wailsjs`，用 `--wails-path` 指定 Wails CLI。`--package` 会把 App、`LICENSE.txt` 和 `README.txt` 一起压缩到 `output/release`，并输出 SHA-256 校验值。

App 的 Bundle 标识符由 `build/darwin/Info.plist` 固定为 `io.orbitssh.macos`，与 Android 的 `io.orbitssh.android` 保持一致；未提供该文件时 Wails 会生成默认模板，标识符会退化为 `com.wails.<项目名>`。

macOS 版的平台差异：

- 系统托盘使用菜单栏图标实现，WSL 只提供 Windows 版本，界面会隐藏对应入口。
- 本地 Shell 在 macOS 上通过伪终端（PTY）运行，使用 `github.com/creack/pty` 启动登录 Shell 及 zsh、bash、sh、fish、tcsh、csh、ksh，Windows 上继续使用 ConPTY。实现分别位于 `src/local/local_darwin.go` 和 `src/local/local_windows.go`，`src/local/pty_unix.go` 存放 macOS 与 Linux 共用的伪终端实现，`src/local/local_linux.go` 提供 Linux 的 Shell 列表，`src/local/local_other.go` 为其余平台保留占位实现。
- 后台常驻在 macOS 上通过菜单栏图标实现，位于 `src/tray/tray_darwin.go`、`src/tray/tray_darwin.m` 和 `src/tray/tray_darwin_callbacks.go`。菜单栏图标使用 SF Symbols（macOS 11 起），低版本回退为自绘的模板图标；菜单栏操作必须回到主线程，所以 Objective-C 侧统一用 `dispatch_async(dispatch_get_main_queue(), ...)`。`.m` 文件必须带 `//go:build darwin && !android && !androidtest`，否则 `go test -tags androidtest` 会因为缺少 cgo 而无法编译。
- 主机配置、凭据和终端历史保存在 `~/Library/Application Support/OrbitSSH`，密码与私钥口令存入 macOS 钥匙串，私钥保留在原始文件位置。
- SSH Agent 读取 `SSH_AUTH_SOCK`；macOS 默认不常驻运行 `ssh-agent`，使用前先执行 `eval "$(ssh-agent -s)"` 并用 `ssh-add` 加载密钥。
- X11 转发需要 XQuartz，认证 cookie 从 `~/.Xauthority` 或 `XAUTHORITY` 指向的文件读取。

脚本默认使用临时签名（ad-hoc），它只能保证本机运行和钥匙串访问稳定。临时签名的 App 在其他机器上仍会被 Gatekeeper 拦截，正式分发需要使用开发者证书签名并公证。

## Linux 构建

在 Linux 上构建需要 Go 1.24 或更新版本、Node.js 22.18 或更新版本，以及 Wails 的 GTK / WebKitGTK 依赖。

WebKitGTK 有 4.0 和 4.1 两个 ABI。Ubuntu 24.04 和 Debian 12 只提供 4.1，Ubuntu 22.04 提供 4.0。构建时用 `-tags webkit2_41` 选择 4.1，缺省会去找 `webkit2gtk-4.0` 并报 *Package webkit2gtk-4.0 was not found*：

```bash
# Ubuntu 24.04 / Debian 12 及以上
sudo apt-get install -y build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev
wails build -platform linux/amd64 -tags webkit2_41
```

```bash
sudo apt-get install -y build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev
go install github.com/wailsapp/wails/v2/cmd/wails@v2.11.0
wails build -platform linux/amd64
```

产物为 `build/bin/OrbitSSH`。Linux 版的平台差异：

- 系统托盘按 StatusNotifierItem 规范实现，纯 Go 的 D-Bus 客户端，不引入 cgo，也不占用 GTK 主循环，实现在 `src/tray/tray_linux.go`。KDE Plasma 原生支持；GNOME 需要安装 AppIndicator 扩展，否则托盘图标不会出现，窗口行为不受影响。
- 本地 Shell 通过伪终端运行，复用 `src/local/pty_unix.go` 中的 PTY 实现，Shell 列表在 `src/local/local_linux.go`。WSL 仍然只提供 Windows 版本。
- 密码与私钥口令保存在 Secret Service，需要系统提供 `org.freedesktop.secrets` 服务；GNOME 之外的桌面可能需要安装 `libsecret` 与 `gnome-keyring`。
- X11 转发需要本机运行 X Server，`XAUTHORITY` 的读取方式与其他平台一致。

## GitHub Actions 发布

`.github/workflows/release.yml` 在推送 `v*` 标签时触发，在 GitHub 托管的 runner 上构建 macOS（arm64 与 x64）、Windows x64 和 Linux x64，并把四个平台的产物合并成一个 Release：

- 产物命名为 `OrbitSSH-v<版本>-<平台>-<架构>.<ext>`，与既有发布保持一致。
- 每个平台的构建在独立 job 中进行，Linux 依赖 `ubuntu-24.04` 的 WebKitGTK 4.1。
- 汇总 job 生成 `SHA256SUMS.txt`，发布说明优先读取 `docs/releases/<标签>.md`，缺失时使用占位文本。
- 工作流会校验标签与 `wails.json`、`frontend/package.json` 的版本号一致，不一致直接失败，避免出现文件名与程序版本对不上的发布。
- 仓库为 public，所有 runner 免费且不限量。

发布前需要先更新 `wails.json` 的 `info.productVersion` 和 `frontend/package.json` 的 `version`，再打标签：

```bash
# 1. 更新版本号并提交
# 2. 打标签推送
git tag v3.1 && git push origin v3.1
```

Android 的 APK 仍使用 `android/build.ps1` 本地构建，签名密钥保留在本地；需要把 APK 一起发布时，在汇总 job 中追加 `actions/upload-artifact` 即可。

## 模块边界

| 位置 | 职责 |
| --- | --- |
| `main.go`、`main_mobile.go` | 模块根目录的入口，负责内嵌前端资源并启动 `src/app`。 |
| `trayasset_*.go` | 内嵌 `build/` 里的托盘图标，交给 `src/tray` 使用。 |
| `src/app/` | `App` 结构体与全部对外方法，以及 SSH、SFTP、监控、转发和工作区等业务逻辑。 |
| `src/platform/` | 操作系统相关能力：配置目录、凭据库、事件、文件对话框和 SSH 连接。 |
| `src/local/` | 本地 Shell 与 WSL 使用的伪终端（PTY / ConPTY）实现。 |
| `src/tray/` | 各平台的系统托盘与菜单栏实现。 |
| `src/sshagent/` | 各平台的 SSH Agent 接入方式。 |
| `src/mcp/` | MCP 客户端配置管理：TOML / JSONC 合并、备份、客户端目录解析和令牌。 |
| `src/mobile/` | Android 主机与 Go 后端之间的管道协议。 |
| `frontend/src/App.tsx` | 组合页面、导航和操作入口。 |
| `frontend/src/hooks/` | 会话连接与回滚、终端布局、历史持久化及可刷新的异步数据。 |
| `frontend/src/TerminalCanvas.tsx`、`splitLayout.ts` | 保持终端挂载，绘制窗格与分隔线；纯布局算法独立测试。 |
| `frontend/src/dialogs/` | 对话框、表单与共用 Modal 焦点管理。 |
| `frontend/src/files/` | 目录状态、文件浏览交互、传输队列和路径工具；`FilesPane.tsx` 负责组合。 |
| `frontend/src/TerminalCatalog.tsx` | 本地 Shell 和 WSL 共用的卡片、刷新、加载、错误及空状态。 |
| `frontend/src/styles/` | 基础样式、应用外壳、主机页、终端、对话框、响应布局、监控和历史；`styles.css` 固定导入顺序。 |
| `src/app/terminal.go`、`terminal_output.go` | SSH 与本地终端共用的输入、尺寸、关闭 API，以及输出缓存和转发。 |
| `src/app/ssh.go`、`local.go`、`wsl*.go` | 各类连接的启动、平台实现与生命周期。 |
| `src/app/tray.go`、`src/tray/` | 托盘状态机与各平台的系统托盘、菜单栏实现。 |
| `src/app/tunneling.go`、`x11.go` | 主机共享的本地、远程和 SOCKS5 TCP 转发，以及每个 SSH 终端的 X11 认证与转发。 |
| `src/app/mcp_server.go`、`mcp_transport.go` | MCP 监听与状态、HTTP 和 JSON-RPC 协议。 |
| `src/app/mcp_tools.go`、`mcp_terminal.go`、`src/mcp/token.go` | MCP 工具、终端读取与检索、令牌持久化。 |
| `src/app/mcp_connections.go`、`frontend/src/hooks/useMCPConnections.ts` | MCP 主机创建、凭据保留在后端的连接请求，以及前端终端挂载后启动 SSH 的衔接。 |
| `src/mcp/`、`src/app/mcp_install_cli.go` | 六种 MCP 客户端的 TOML / JSONC 配置合并与备份、客户端目录解析、桌面一键接入 API，以及启动图形界面前处理的 `install` 命令。 |
| `src/mobile/`、`src/app/mobile_api.go`、`android/src/` | Android 管道协议、公开 API 白名单与系统接口，复用同一个 Go 后端。 |

公开的 `App` 方法同时供 Wails 和 Android 桥接使用；移动实现时保留签名、事件名称和数据格式。绑定的方法必须和 `App` 结构体放在同一个包里，因此 `src/app` 承载了全部对外方法，其余包只提供不含 `App` 方法的实现。布局变化必须保持 `TerminalPane` 的会话 ID 和挂载状态，避免重复连接或丢失终端内容。样式入口按现有覆盖顺序加载，新增规则放到对应功能文件中。

## 数据与实现约定

端口转发规则与 X11 设置随主机保存，旧配置默认不启用。每个启用转发的主机使用一个独立 SSH 连接维护监听，按终端引用计数，在最后一个终端关闭时释放；启动失败回收已创建的监听。X11 使用终端自身的 SSH 连接，先登记 `x11` 通道处理器再发送 `x11-req`，并在打开 shell 前完成请求。实际 Xauthority cookie 不传给服务器，也不写入配置。

`src/app/tunneling_test.go` 使用本地 SSH 服务验证真实 TCP 数据、三种 SOCKS5 地址格式、远程 DNS、半关闭、多个终端共享以及启动回滚；`src/app/x11_test.go` 用模拟 X Server 验证通道数据、随机 cookie 替换、错误认证拦截和 Xauthority 匹配。这些测试无需系统安装 sshd 或 X Server。

配置位置：

| 系统 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\OrbitSSH\workspace.json` |
| macOS | `~/Library/Application Support/OrbitSSH/workspace.json` |
| Linux | `$XDG_CONFIG_HOME/OrbitSSH/workspace.json`，默认 `~/.config/OrbitSSH/workspace.json` |

密码和私钥口令分别通过 Windows 凭据管理器、macOS Keychain 或 Linux Secret Service 保存。配置 JSON 不包含这些凭据，私钥文件保留在原位置。

SFTP 传输先写入临时文件，成功后替换目标；取消时清理当前临时文件，已完成文件保留。递归传输跳过符号链接和特殊文件，已有传输目标是符号链接时拒绝写入，不支持断点续传。

远程文本编辑支持最大 2 MB 的 UTF-8 文件，本地只读预览最多显示前 256 KB。保存保留 BOM、LF / CRLF、Unix 权限与所有者，混合换行修改后统一为 LF。编辑符号链接时打开其实际目标并保留链接。保存前后核对内容版本，再重命名替换；SFTP 不提供跨程序版本锁，检测与替换之间仍有竞争窗口。原文件的 ACL、扩展属性及硬链接关系不复制到替换文件。
