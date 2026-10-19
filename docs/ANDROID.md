# Android 本地构建与安装

Android 版复用桌面版的 Go SSH / SFTP、主机指纹校验、监控、文件编辑和 React 界面。Android 原生宿主提供 WebView、文件选择器、剪贴板和 Android Keystore。支持 **Android 9（API 28）及以上的 ARM64 手机 / 平板**；界面需要支持现代 JavaScript 的 Android System WebView。

## 生成 APK

Windows 构建需要 Go 1.24+、Node.js 20+、JDK 17 / 21、Android SDK Platform 35 和 Android SDK Build-Tools 35+。默认使用 Android Studio 自带 JDK 和 `%LOCALAPPDATA%\Android\Sdk`，也支持 `ANDROID_SDK_ROOT` / `ANDROID_HOME`。不需要 Gradle 或 NDK。

在仓库根目录运行：

```powershell
.\android\build.ps1
```

需要指定路径时：

```powershell
.\android\build.ps1 -SdkPath "$env:LOCALAPPDATA\Android\Sdk" -JdkPath "C:\Program Files\Android\openjdk\jdk-21.0.8"
```

产物为 `build/bin/OrbitSSH-v1.0.3-android-arm64.apk`（文件名跟随 AndroidManifest 中的版本号）。构建脚本编译前端、Go ARM64 PIE 可执行文件、Java 与 DEX，打包并执行 APK 签名、16 KB 对齐和本地界面资源完整性校验。SDK 工具和 JDK 的路径可以含空格。

APK 使用本机生成的 `android/orbit-local.keystore` 签名，适合直接安装测试。该文件不会提交到 Git；保留它才能用后续本机构建覆盖安装并保留配置。这不是应用商店发布包。

把 APK 传到手机后打开，按系统提示允许当前文件管理器安装应用。也可以在开启 USB 调试并连接设备后运行：

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r .\build\bin\OrbitSSH-v1.0.3-android-arm64.apk
```

## 手机上使用

界面、配置和凭据均保存在手机本地，打开应用不需要联网；连接 SSH / SFTP 服务器时需要能访问该服务器。`https://appassets.androidplatform.net/` 是 WebView 加载 APK 内文件所用的内部地址，由原生宿主直接返回资源，不访问网站。

系统状态栏与底部导航栏跟随应用主题：浅色主题使用深色图标，深色主题使用浅色图标，背景与应用顶部衔接。原生宿主为 Android 15+ 的透明系统栏绘制背景，并保留状态栏、屏幕开孔和软键盘的安全区域。

- 添加主机后点击「连接」，支持密码和导入 PEM / OpenSSH 私钥；首次连接仍须确认服务器指纹。
- 终端底部提供 Esc、Tab、Ctrl、方向键、中断和粘贴。Ctrl 按一次后对下一个输入字符生效；「中断」直接发送 Ctrl+C。「键盘」按钮可打开软键盘，支持外接键盘。
- 长按终端文字选择单词，按住拖动可扩展选择范围；松手后显示安卓原生浮动菜单，提供复制、粘贴和全选。粘贴多行命令仍需确认。
- 双指张开或收拢调整终端字号（11–22 px），松手后保存；单指仍用于滚动输出。键盘弹出时由原生宿主统一调整可用高度，顶部导航保持原位。
- 手机上文件管理器通过「本地文件 / 远程文件」标签切换；平板横屏可同时显示两栏。点击本地一栏的文件夹按钮，可从系统文件选择器导入一个或多个文件，然后上传。
- 远程下载先保存到应用的本地文件区；选择其中一个普通文件，点击「导出到手机」按钮，通过系统选择保存位置。取消系统选择不会覆盖已有文件。导入同名文件会自动改名，原文件保留。
- 私钥导入到应用私有目录；主机配置与信任指纹保存在应用私有目录；密码和私钥口令使用 Android Keystore 中的 AES-GCM 密钥加密保存，不写入 workspace JSON。
- WSL 仅适用于 Windows，在 Android 中隐藏。Android 与 Windows 各自保存配置。

当前版本主要面向前台使用，尚未加入保持后台连接的前台服务；系统回收应用、强行停止或退出会结束会话和传输。后台长时间运行及锁屏保持连接需要实机进一步验证。卸载会删除应用配置、凭据、导入的私钥和应用文件区，重要下载请先导出。

## 实现和验证

Android Go 引擎打包为 `lib/arm64-v8a/liborbit.so`，由系统提取到只读原生库目录后启动。它是 PIE 可执行文件，通过进程标准输入 / 输出与宿主交换 JSON 请求、响应和终端事件，不监听本地网络端口。界面只加载 APK 中的资源；导航和资源请求由宿主限制在应用资源域。

资源 ZIP 路径统一使用 `/`，避免 Windows 打包工具写入 `\` 后 Android 无法找到 `www/index.html`。构建结束时检查签名 APK 中的首页、所有前端文件及必需的原生文件，路径错误或文件缺失会使构建失败。

Android 宿主处理系统域名解析，以适配 Android 私有 DNS、VPN 和网络切换。SSH 认证、指纹保存、连接、传输和编辑均使用原有 Go 实现。

```powershell
cd frontend
npm run build
cd ..
go test ./...
go vet ./...
go test -tags androidtest -run '^TestMobile' -v -timeout 45s .
```

移动端协议测试在主机上运行，连接临时 SSH / SFTP 服务，验证首次指纹确认、终端 Unicode 输出、SFTP 浏览、系统 DNS 回调、保存凭据后重连和凭据不进入配置。原生文件选择、Android Keystore、软键盘和后台生命周期仍需安装到 Android 设备验证。
