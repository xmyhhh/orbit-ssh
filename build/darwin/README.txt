Orbit SSH
=========

安装
----
1. 把「Orbit SSH.app」拖到「Applications」（应用程序）文件夹。
2. 首次打开如果提示「Apple 无法验证 "Orbit SSH" 是否包含可能危害 Mac 安全
   或泄漏隐私的恶意软件」，在「应用程序」里右键点击 Orbit SSH 选择「打开」，
   或在终端执行下面的命令后重新打开：

   xattr -dr com.apple.quarantine "/Applications/Orbit SSH.app"

说明
----
浏览器下载的文件会带上 quarantine 标记，macOS 因此会校验应用签名。本版本使用
临时签名（ad-hoc），没有开发者证书，系统无法确认开发者身份，所以会弹出上面
的提示。清除标记后即可正常使用。

配置、凭据和终端历史保存在 ~/Library/Application Support/OrbitSSH，密码与私钥
口令存入钥匙串；菜单栏图标可让应用常驻后台。

项目主页：https://github.com/xmyhhh/orbit-ssh
