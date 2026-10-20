//go:build !android && !androidtest

package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"

	"github.com/tailscale/hujson"
)

// Change only Orbit SSH's value (or insert a missing member) in the lossless
// syntax tree. Other settings, comments and number literals remain intact.
func (client Client) updateJSONConfig(original []byte, endpoint, token string) ([]byte, error) {
	if endpoint == "" || token == "" {
		return nil, errors.New("MCP 地址和访问令牌不能为空")
	}
	data := original
	var bom []byte
	if bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		bom, data = data[:3:3], data[3:]
	}
	if len(bytes.TrimSpace(data)) == 0 {
		data = []byte("{}\n")
	}
	document, err := hujson.Parse(data)
	if err != nil || !uniqueMCPJSONKeys(document) {
		// Never include parser diagnostics: source lines can contain credentials.
		return nil, fmt.Errorf("%s 配置不是有效的 JSON/JSONC，或包含重复字段；请先修复，原文件已保留", client.name)
	}
	root, ok := document.Value.(*hujson.Object)
	if !ok {
		return nil, fmt.Errorf("%s 配置必须是 JSON 对象；原文件已保留", client.name)
	}
	standard := document.Clone()
	standard.Standardize()
	var config map[string]any
	decoder := json.NewDecoder(bytes.NewReader(standard.Pack()))
	decoder.UseNumber()
	if err := decoder.Decode(&config); err != nil {
		return nil, fmt.Errorf("无法读取 %s 配置；原文件已保留", client.name)
	}
	servers, ok := config[client.namespace].(map[string]any)
	if _, exists := config[client.namespace]; exists && !ok {
		return nil, fmt.Errorf("%s 配置的 %s 必须是对象；原文件已保留", client.name, client.namespace)
	}
	existing, ok := servers["orbit-ssh"].(map[string]any)
	if _, exists := servers["orbit-ssh"]; exists && !ok {
		return nil, fmt.Errorf("%s 配置的 orbit-ssh 必须是对象；原文件已保留", client.name)
	}
	entry := make(map[string]any, len(existing)+4)
	for key, value := range existing {
		entry[key] = value
	}
	for _, key := range []string{"command", "args", "env", "environment", "envFile", "cwd", "url", "httpUrl", "type", "oauth"} {
		delete(entry, key)
	}
	headers := map[string]any{}
	previous, ok := existing["headers"].(map[string]any)
	if _, exists := existing["headers"]; exists && !ok {
		return nil, fmt.Errorf("%s 配置的 headers 必须是对象；原文件已保留", client.name)
	}
	for key, value := range previous {
		if !strings.EqualFold(key, "Authorization") {
			headers[key] = value
		}
	}
	headers["Authorization"] = "Bearer " + token
	entry["headers"] = headers
	entry["url"] = endpoint
	switch client.target {
	case "claude", "vscode":
		entry["type"] = "http"
	case "opencode":
		entry["type"] = "remote"
		entry["enabled"] = true
		entry["oauth"] = false
	case "gemini":
		delete(entry, "url") // Gemini's url is SSE; httpUrl is Streamable HTTP.
		entry["httpUrl"] = endpoint
	}
	if _, exists := entry["disabled"]; exists {
		entry["disabled"] = false
	}
	if reflect.DeepEqual(existing, entry) {
		return original, nil
	}
	newline := "\n"
	if bytes.Contains(data, []byte("\r\n")) {
		newline = "\r\n"
	}
	parent := root
	key := client.namespace
	var value any = map[string]any{"orbit-ssh": entry}
	if namespace := mcpJSONMember(root, client.namespace); namespace != nil {
		parent = namespace.Value.Value.(*hujson.Object)
		key, value = "orbit-ssh", entry
	}
	member := mcpJSONMember(parent, key)
	indent := "  "
	if parent != root {
		indent = mcpJSONIndent(data, mcpJSONMember(root, client.namespace).Name.StartOffset, "  ") + "  "
	}
	if len(parent.Members) > 0 {
		indent = mcpJSONIndent(data, parent.Members[0].Name.StartOffset, indent)
	}
	encoded, err := json.MarshalIndent(value, indent, "  ")
	if err != nil {
		return nil, fmt.Errorf("无法生成 %s 配置；原文件已保留", client.name)
	}
	encoded = bytes.ReplaceAll(encoded, []byte("\n"), []byte(newline))
	replacement, err := hujson.Parse(encoded)
	if err != nil {
		return nil, fmt.Errorf("无法生成 %s 配置；原文件已保留", client.name)
	}
	if member != nil {
		member.Value.Value = replacement.Value
	} else {
		before := append(append(hujson.Extra{}, parent.AfterExtra...), []byte(newline+indent)...)
		parent.Members = append(parent.Members, hujson.ObjectMember{
			Name:  hujson.Value{BeforeExtra: before, Value: hujson.String(key)},
			Value: hujson.Value{BeforeExtra: hujson.Extra(" "), Value: replacement.Value},
		})
		parent.AfterExtra = hujson.Extra(newline + strings.TrimSuffix(indent, "  "))
	}
	return append(bom, document.Pack()...), nil
}

func mcpJSONMember(object *hujson.Object, key string) *hujson.ObjectMember {
	for i := range object.Members {
		if object.Members[i].Name.Value.(hujson.Literal).String() == key {
			return &object.Members[i]
		}
	}
	return nil
}

func mcpJSONIndent(data []byte, offset int, fallback string) string {
	start := bytes.LastIndexByte(data[:offset], '\n') + 1
	indent := string(data[start:offset])
	if strings.Trim(indent, " \t") == "" {
		return indent
	}
	return fallback
}

func uniqueMCPJSONKeys(value hujson.Value) bool {
	switch node := value.Value.(type) {
	case *hujson.Object:
		seen := map[string]bool{}
		for _, member := range node.Members {
			key := member.Name.Value.(hujson.Literal).String()
			if seen[key] || !uniqueMCPJSONKeys(member.Value) {
				return false
			}
			seen[key] = true
		}
	case *hujson.Array:
		for _, element := range node.Elements {
			if !uniqueMCPJSONKeys(element) {
				return false
			}
		}
	}
	return true
}
