# Orbit SSH

个人 SSH 桌面工具。无需账号，不做云同步或联网激活，配置和凭据保存在本机；SSH / SFTP 连接你添加的服务器。Wails v2 + Go + React + TypeScript + xterm.js，使用系统 WebView。默认浅色，可切换深色或跟随系统。

## 使用

Windows 可直接运行 `build/bin/OrbitSSH-v0.3.11.exe`，需要系统已安装 WebView2 Runtime（Windows 11 通常自带）。

- 添加主机，保存地址、端口、用户名；支持密码和 PEM / OpenSSH 私钥认证。
- 双击主机卡片快速连接，网格和列表视图均支持；已连接的主机双击会新开一个独立终端。已保存的凭据自动使用，未保存时提示输入。
- 用户名和私钥文件路径自动保存。密码登录勾选“记住密码”后，连接成功时加密保存，下次连接免输入；加密私钥也可记住私钥口令。密码与口令使用 Windows 凭据管理器 / macOS Keychain / Linux Secret Service 保存在本机。
- 首次连接核对 SHA-256 服务器指纹，之后自动验证；指纹变化时拒绝连接。
- 终端支持多标签、搜索、命令片段、多行粘贴确认。浅色终端使用灰绿色背景，支持 Ctrl +/−、Ctrl 0、Ctrl + 滚轮缩放，偏好设置可调字号和行距。
- 内置 40 条常用 Linux 命令片段，覆盖系统、磁盘文件、进程、网络、日志服务、Docker 和 Git；支持分类、搜索、自定义和编辑。点击可复制或插入终端，按 Enter 才执行。旧配置升级时追加新片段，保留自定义内容并跳过重复命令，之后删除的预置不会在重启时恢复。
- 同一主机可打开多个独立终端：点击工具栏“新建终端”、终端标签旁的“＋”，或按 Ctrl / ⌘ Shift T。标签按 #1、#2 编号，关闭一个终端不影响其他终端；已保存的密码或私钥口令自动用于新终端。
- 同一主机的会话收在一个主机标签内，下面切换各个终端；切换主机时记住上次使用的终端。主机标签的关闭按钮可关闭该主机全部会话，多会话时先确认。
- “文件”打开双栏文件管理器：左侧本地，右侧远程。支持路径跳转、隐藏文件、筛选、多选、新建文件夹。
- 右键远程文件选择“编辑”，或双击远程文本直接编辑，Ctrl / ⌘ S 保存到服务器。支持 Shell、JSON、YAML、Nginx、Python、JS/TS、HTML/CSS、SQL、Markdown、XML、INI、TOML、Dockerfile、Go、Rust、C/C++、Java 高亮，可自动识别或手动切换；提供行号、折叠、撤销、查找替换和自动换行。本地文本可只读预览并高亮。文件菜单也支持 Shift F10 / 菜单键打开，Esc 关闭。
- 关闭或重新载入未保存的文件时会确认，退出应用也会提醒。保存失败或检测到远端文件变化时保留当前修改，确认后可重新载入远端版本。
- 左侧选中项目后点击“上传”，发送到右侧当前目录；右侧选中项目后点击“下载”，保存到左侧当前目录。支持多文件与递归文件夹传输，同名文件默认跳过，可切换为替换。
- 传输队列显示进度、速度和失败原因，支持取消。切回终端或切换标签不影响后台传输；关闭连接或退出应用会中断传输。队列记录保留在本次运行中。
- “监控”打开 CPU、内存、交换空间、磁盘和进程列表。可展开面板、暂停、手动刷新，或选择 3 / 5 / 10 秒间隔；窗口隐藏时暂停采样。

监控目前支持 Linux 服务器，需要 `/proc`、`df` 和 procps 的 `ps`。通过独立 SSH exec 通道只读采样，无需安装远端程序。CPU 使用率在第二次采样后显示；内存已用量按 `MemTotal - MemAvailable` 计算。进程 CPU 为 `ps` 报告的生命周期平均值，多核可超过 100%；每次最多读取 CPU 排名前 500 个进程。磁盘展示空间使用情况。

## 本地数据

主机、用户名、私钥路径、主题与指纹保存为本地 JSON，私钥保留在原文件位置。JSON 不保存密码或私钥口令，前端也无法读取已保存的密码。密码与主机地址、端口和用户名绑定，修改这些信息后需要重新输入。可在主机编辑窗口清除保存的密码或私钥口令；取消勾选“记住密码”后成功连接，也会清除该主机已保存的密码。系统凭据库不可用时会明确提示，不回退到明文存储。

配置路径：

- Windows：`%APPDATA%\OrbitSSH\workspace.json`
- macOS：`~/Library/Application Support/OrbitSSH/workspace.json`
- Linux：`$XDG_CONFIG_HOME/OrbitSSH/workspace.json`，默认 `~/.config/OrbitSSH/workspace.json`

网页开发预览使用独立 localStorage，与桌面配置分开。网页的体验终端、监控和文件数据均为演示；真实 SSH 连接在桌面版使用。

文件传输通过 SFTP 完成，服务器需开启 SFTP 子系统。符号链接和特殊文件跳过，不跟随链接递归；已有传输目标符号链接拒绝写入。传输先写入临时文件，成功后替换目标；取消会清理当前临时文件，已经完成的文件会保留。目前不支持断点续传，断网后可重新选择项目传输。

远程编辑支持完整读取不超过 2 MB 的 UTF-8 文本，保留 BOM、LF / CRLF、Unix 权限与所有者；混合换行修改后统一为 LF。编辑符号链接时打开其实际目标，保留链接。本地只读预览最多显示前 256 KB。保存需要目录的临时文件创建与重命名权限，不提供 sudo 提权；上传前后核对内容版本，再重命名替换，不删除原文件后重建。SFTP 不提供跨程序的版本锁，检测与替换之间仍有很短的竞争窗口。原文件的 ACL、扩展属性及硬链接关系不复制到替换文件。

## 开发与构建

安装 Go 1.24+、Node.js 20+，以及 Wails 对应系统的构建依赖。Windows 需要 C 编译工具和 WebView2；macOS 需要 Xcode Command Line Tools；Linux 需要 GTK / WebKitGTK 和可用的 Secret Service。

```powershell
cd frontend
npm install
npm run build
cd ..
go test ./...
go vet ./...
go run github.com/wailsapp/wails/v2/cmd/wails@v2.11.0 dev
```

Windows 打包：

```powershell
go run github.com/wailsapp/wails/v2/cmd/wails@v2.11.0 build -o OrbitSSH-v0.3.11.exe -platform windows/amd64 -webview2 browser
```

macOS、Linux 在对应系统执行 Wails build。当前交付已在 Windows 编译与验证，其他平台仍需原生构建验证。

注意 Go 会嵌入 `frontend/dist`，请先完成前端构建再执行 Go 检查，避免同时改写 dist。默认测试使用本地 SSH / SFTP 服务和模拟凭据库，不接触用户配置。

真实监控测试可显式设置 `ORBIT_TEST_MONITOR_HOST` 为应用中已保存的主机名称或 ID，再运行 `go test -run '^TestMonitorLiveHost$' -v`。它使用已信任的主机指纹和已保存的凭据，只读采集两次；工作空间使用临时副本。
