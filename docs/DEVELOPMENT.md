# 开发与构建

Orbit SSH 使用 Wails v2、Go、React、TypeScript 和 xterm.js，桌面界面使用系统 WebView。面向使用者的下载和操作说明见 [README](../README.md)。

## 环境要求

- Go 1.24 或更新版本。
- Node.js 20 或更新版本及 npm。
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
npm run build
cd ..
go test ./...
go vet ./...
```

Go 会嵌入 `frontend/dist`，请先完成前端构建，再执行 Go 检查，避免同时改写 dist。默认测试使用本地 SSH / SFTP 服务和模拟凭据库，不接触用户配置。

Windows 本地终端测试会通过真实 ConPTY 启动检测到的 PowerShell、CMD 和 PowerShell 7，验证独立会话、中文输出、用户主目录、尺寸调整与退出事件；不需要安装 WSL 发行版。本地 Shell 与 WSL 共用会话输入输出和关闭逻辑。

Windows 系统托盘通过 Win32 通知区域 API 实现，使用内嵌应用图标，不增加 CGo 依赖。托盘测试在有 Explorer 通知区域的会话中验证真实图标注册、菜单回调、任务栏恢复通知和退出清理；没有通知区域时跳过这项桌面集成测试。关闭行为测试覆盖保留会话和编辑内容、取消退出以及旧配置的默认迁移。

真实服务器监控测试需显式设置 `ORBIT_TEST_MONITOR_HOST` 为应用中已保存的主机名称或 ID，再运行：

```powershell
go test -run '^TestMonitorLiveHost$' -v
```

该测试使用已信任的指纹和已保存的凭据，只读采集两次，工作空间使用临时副本。

## Windows x64 发布构建

```powershell
go run github.com/wailsapp/wails/v2/cmd/wails@v2.11.0 build -o OrbitSSH-v1.0-windows-x64.exe -platform windows/amd64 -webview2 browser
```

产物为 `build/bin/OrbitSSH-v1.0-windows-x64.exe`。该命令会先构建前端，生成的绑定、前端构建目录及可执行文件不提交到 Git；可执行文件作为 GitHub Release 附件上传。

发布标签使用 `v1.0`，npm 与 Wails 的产品版本使用 `1.0.0`，界面显示 `v1.0`。发布说明保存在 [docs/releases/v1.0.md](releases/v1.0.md)。

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
