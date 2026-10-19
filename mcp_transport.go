package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
)

const mcpProtocolVersion = "2025-06-18"
const mcpRequestLimit = 1024 * 1024

type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type mcpResponse struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id"`
	Result  any    `json:"result,omitempty"`
	Error   any    `json:"error,omitempty"`
}

func (a *App) mcpHandler(token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if !isLocalMCPOrigin(origin) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			if origin != "" {
				w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Protocol-Version")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST, OPTIONS")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !validMCPAuthorization(r.Header.Get("Authorization"), token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mediaType, _, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if mediaErr != nil || mediaType != "application/json" {
			http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
			return
		}
		if !acceptsMCPResponse(r.Header.Get("Accept")) {
			http.Error(w, "accept must include application/json or text/event-stream", http.StatusNotAcceptable)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, mcpRequestLimit+1))
		if err != nil {
			http.Error(w, "could not read request", http.StatusBadRequest)
			return
		}
		if len(body) > mcpRequestLimit {
			http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
			return
		}
		var request mcpRequest
		if err = json.Unmarshal(body, &request); err != nil {
			writeMCPJSON(w, http.StatusOK, mcpResponse{JSONRPC: "2.0", ID: nil, Error: map[string]any{"code": -32700, "message": "Parse error"}})
			return
		}
		if request.JSONRPC != "2.0" || request.Method == "" || (len(request.ID) > 0 && string(request.ID) == "null") {
			writeMCPJSON(w, http.StatusOK, mcpErrorResponse(request.ID, -32600, "Invalid Request"))
			return
		}
		if len(request.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		result, rpcErr := a.handleMCPRequest(r.Context(), request)
		if rpcErr != nil {
			writeMCPJSON(w, http.StatusOK, mcpErrorResponse(request.ID, rpcErr.code, rpcErr.message))
			return
		}
		writeMCPJSON(w, http.StatusOK, mcpResponse{JSONRPC: "2.0", ID: request.ID, Result: result})
	})
	return mux
}

type mcpRPCError struct {
	code    int
	message string
}

func (a *App) handleMCPRequest(ctx context.Context, request mcpRequest) (any, *mcpRPCError) {
	switch request.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if err := json.Unmarshal(request.Params, &params); err != nil {
			return nil, &mcpRPCError{code: -32602, message: "Invalid params"}
		}
		version := mcpProtocolVersion
		if params.ProtocolVersion == "2025-03-26" || params.ProtocolVersion == mcpProtocolVersion {
			version = params.ProtocolVersion
		}
		return map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "orbit-ssh", "version": "1.0.0"},
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": mcpToolDefinitions()}, nil
	case "tools/call":
		var params struct {
			Name      string                     `json:"name"`
			Arguments map[string]json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(request.Params, &params); err != nil || params.Name == "" {
			return nil, &mcpRPCError{code: -32602, message: "Invalid params"}
		}
		if !knownMCPTool(params.Name) {
			return nil, &mcpRPCError{code: -32602, message: "Unknown tool"}
		}
		return a.callMCPToolContext(ctx, params.Name, params.Arguments), nil
	default:
		return nil, &mcpRPCError{code: -32601, message: "Method not found"}
	}
}

func isLocalMCPOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "http" {
		return false
	}
	host := parsed.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func validMCPAuthorization(header, token string) bool {
	if !strings.HasPrefix(header, "Bearer ") || token == "" {
		return false
	}
	presented := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	if len(presented) != len(token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(token)) == 1
}

func acceptsMCPResponse(header string) bool {
	header = strings.ToLower(strings.TrimSpace(header))
	if header == "" || header == "*/*" {
		return true
	}
	return strings.Contains(header, "application/json") || strings.Contains(header, "text/event-stream") || strings.Contains(header, "*/*")
}

func writeMCPJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func mcpErrorResponse(id json.RawMessage, code int, message string) mcpResponse {
	return mcpResponse{JSONRPC: "2.0", ID: id, Error: map[string]any{"code": code, "message": message}}
}
