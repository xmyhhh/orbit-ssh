//go:build !android && !androidtest

package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"strings"
)

func runMCPInstallCommand(args []string, input io.Reader, output io.Writer) (bool, error) {
	return runMCPInstallCommandWithConfig(args, input, output, platformConfigDirectory)
}

func runMCPInstallCommandWithConfig(args []string, input io.Reader, output io.Writer, configDirectory func() (string, error)) (bool, error) {
	if len(args) == 0 || args[0] != "install" {
		return false, nil
	}
	flags := flag.NewFlagSet("install", flag.ContinueOnError)
	flags.SetOutput(output)
	target := flags.String("target", "codex", "MCP 客户端：codex、claude、cursor、opencode、gemini、vscode；逗号分隔或 all")
	location := flags.String("location", "global", "配置位置：global 或 local（当前项目）")
	yes := flags.Bool("yes", false, "直接写入配置，跳过交互确认")
	if err := flags.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return true, nil
		}
		return true, err
	}
	if flags.NArg() != 0 {
		return true, errors.New("install 不接受位置参数")
	}
	clients, err := selectMCPClients(*target)
	if err != nil {
		return true, err
	}
	paths := make([]string, len(clients))
	for i, client := range clients {
		paths[i], err = client.configPath(*location)
		if err != nil {
			return true, err
		}
	}
	if !*yes {
		for i, client := range clients {
			fmt.Fprintf(output, "将 Orbit SSH MCP 接入 %s：%s\n", client.name, paths[i])
		}
		fmt.Fprint(output, "已有配置会先备份。继续？[y/N] ")
		answer, readErr := bufio.NewReader(input).ReadString('\n')
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return true, readErr
		}
		answer = strings.TrimSpace(answer)
		if !strings.EqualFold(answer, "y") && !strings.EqualFold(answer, "yes") {
			fmt.Fprintln(output, "已取消。")
			return true, nil
		}
	}
	directory, err := configDirectory()
	if err != nil {
		return true, err
	}
	directory = filepath.Join(directory, "OrbitSSH")
	store, err := openStore(filepath.Join(directory, "workspace.json"))
	if err != nil {
		return true, err
	}
	token, err := loadOrCreateMCPToken(filepath.Join(directory, "mcp-token"))
	if err != nil {
		return true, err
	}
	preferences := store.snapshot().Preferences
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/mcp", preferences.MCPPort)
	var failures []error
	for i, client := range clients {
		result, installErr := client.install(paths[i], endpoint, token)
		if installErr != nil {
			failures = append(failures, installErr)
			continue
		}
		if result.Changed {
			fmt.Fprintf(output, "已将 Orbit SSH MCP 接入 %s：%s\n", client.name, result.ConfigPath)
		} else {
			fmt.Fprintf(output, "%s 已接入当前 Orbit SSH MCP：%s\n", client.name, result.ConfigPath)
		}
		if result.BackupPath != "" {
			fmt.Fprintf(output, "原配置备份：%s\n", result.BackupPath)
		}
		fmt.Fprintf(output, "请重启 %s 以加载配置。\n", client.name)
	}
	fmt.Fprintln(output, "请在 Orbit SSH 中启用本机 MCP 服务并保持应用运行。")
	if *location == "local" {
		fmt.Fprintln(output, "项目配置可能需要客户端的项目信任或 MCP 授权；文件包含本机令牌，请勿提交到版本控制。")
	}
	return true, errors.Join(failures...)
}
