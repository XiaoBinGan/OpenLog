package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"openlog/config"
	"openlog/db"
	"openlog/remote"
)

// ============ Models ============

type MonitorStats struct {
	CPU        float64     `json:"cpu"`
	MemUsed    uint64      `json:"memUsed"`
	MemTotal   uint64      `json:"memTotal"`
	DiskUsed   uint64      `json:"diskUsed"`
	DiskTotal  uint64      `json:"diskTotal"`
	NetworkIn  uint64      `json:"networkIn"`
	NetworkOut uint64      `json:"networkOut"`
	Procs      []ProcInfo  `json:"procs"`
	GPUs       []GPUInfo    `json:"gpus"`
	Uptime     uint64      `json:"uptime"`
	Hostname   string      `json:"hostname"`
	OS         string      `json:"os"`
	Platform   string      `json:"platform"`
	BootTime   uint64      `json:"bootTime"`
}

type ProcInfo struct {
	PID  int32   `json:"pid"`
	Name string  `json:"name"`
	CPU  float64 `json:"cpu"`
	Mem  float64 `json:"mem"`
}

type GPUInfo struct {
	Index    int    `json:"index"`
	Name     string `json:"name"`
	Util     int    `json:"util"`
	MemUsed  int    `json:"memUsed"`
	MemTotal int    `json:"memTotal"`
	Temp     int    `json:"temp"`
}

type LogEntry struct {
	Time    string `json:"time"`
	Level   string `json:"level"`
	Message string `json:"message"`
	Raw     string `json:"raw"`
}

type LogSource struct {
	ID      string     `json:"id"`
	Name    string     `json:"name"`
	Path    string     `json:"path"`
	Entries []LogEntry `json:"entries"`
	Offsets map[string]int64
	mu      sync.RWMutex
}

var logSources = make(map[string]*LogSource)
var logSourcesMu sync.RWMutex
const MaxLogEntries = 10000

// ============ WebSocket Hub ============

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type WSClient struct {
	conn *websocket.Conn
	send chan []byte
	typ  string
}

type WSHub struct {
	clients    map[*WSClient]bool
	broadcast  chan []byte
	register   chan *WSClient
	unregister chan *WSClient
	mu         sync.RWMutex
}

func NewWSHub() *WSHub {
	return &WSHub{
		clients:    make(map[*WSClient]bool),
		broadcast:  make(chan []byte, 256),
		register:   make(chan *WSClient),
		unregister: make(chan *WSClient),
	}
}

func (h *WSHub) Run() {
	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			h.clients[c] = true
			h.mu.Unlock()
		case c := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[c]; ok {
				delete(h.clients, c)
				close(c.send)
			}
			h.mu.Unlock()
		case msg := <-h.broadcast:
			h.mu.RLock()
			for c := range h.clients {
				if c.typ == "main" {
					select {
					case c.send <- msg:
					default:
						close(c.send)
						delete(h.clients, c)
					}
				}
			}
			h.mu.RUnlock()
		}
	}
}

func (h *WSHub) Broadcast(msg []byte) {
	select {
	case h.broadcast <- msg:
	default:
	}
}

var wsHub = NewWSHub()

// ============ Monitor Service ============

var monitorHistory []MonitorStats
var monitorHistoryMu sync.RWMutex
const MaxHistoryLen = 1000

func collectLocalStats() MonitorStats {
	var s MonitorStats
	if ci, err := cpu.Info(); err == nil && len(ci) > 0 {
		if pct, err := cpu.Percent(time.Second, false); err == nil && len(pct) > 0 {
			s.CPU = pct[0]
		}
		_ = ci
	}
	if mi, err := mem.VirtualMemory(); err == nil {
		s.MemUsed = mi.Used
		s.MemTotal = mi.Total
	}
	if du, err := disk.Usage("/"); err == nil {
		s.DiskUsed = du.Used
		s.DiskTotal = du.Total
	}
	if ni, err := net.IOCounters(false); err == nil && len(ni) > 0 {
		s.NetworkIn = ni[0].BytesRecv
		s.NetworkOut = ni[0].BytesSent
	}
	if hi, err := host.Info(); err == nil {
		s.Hostname = hi.Hostname
		s.OS = hi.OS
		s.Platform = hi.Platform
		s.Uptime = hi.Uptime
		s.BootTime = hi.BootTime
	}
	s.GPUs = collectLocalGPU()
	return s
}

func collectLocalGPU() []GPUInfo {
	var gpus []GPUInfo
	out, err := exec.Command("nvidia-smi", "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits").Output()
	if err != nil {
		return gpus
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, ",")
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}
		if len(parts) < 6 {
			continue
		}
		var g GPUInfo
		fmt.Sscanf(parts[0], "%d", &g.Index)
		g.Name = parts[1]
		fmt.Sscanf(parts[2], "%d", &g.Util)
		fmt.Sscanf(parts[3], "%d", &g.MemUsed)
		fmt.Sscanf(parts[4], "%d", &g.MemTotal)
		fmt.Sscanf(parts[5], "%d", &g.Temp)
		gpus = append(gpus, g)
	}
	return gpus
}

func startMonitor() {
	ticker := time.NewTicker(3 * time.Second)
	go func() {
		for range ticker.C {
			s := collectLocalStats()
			monitorHistoryMu.Lock()
			monitorHistory = append(monitorHistory, s)
			if len(monitorHistory) > MaxHistoryLen {
				monitorHistory = monitorHistory[len(monitorHistory)-MaxHistoryLen:]
			}
			monitorHistoryMu.Unlock()

			// Broadcast to WS clients
			data, _ := json.Marshal(map[string]interface{}{"type": "stats", "stats": s})
			wsHub.Broadcast(data)
		}
	}()
}

// ============ Log Service ============

func watchLog(source *LogSource) {
	go func() {
		for {
			file, err := os.Open(source.Path)
			if err != nil {
				time.Sleep(5 * time.Second)
				continue
			}

			if off, ok := source.Offsets[source.Path]; ok {
				file.Seek(off, 0)
			}

			reader := io.Reader(file)
			buf := make([]byte, 4096)
			for {
				n, err := reader.Read(buf)
				if n > 0 {
					text := string(buf[:n])
					lines := strings.Split(text, "\n")
					source.mu.Lock()
					for _, line := range lines {
						if line == "" {
							continue
						}
						entry := parseLogLine(line)
						source.Entries = append(source.Entries, entry)
						if len(source.Entries) > MaxLogEntries {
							source.Entries = source.Entries[len(source.Entries)-MaxLogEntries:]
						}
					}
					source.mu.Unlock()

					// Broadcast
					broadcast := map[string]interface{}{
						"type":   "log",
						"source": source.ID,
						"raw":    text,
					}
					data, _ := json.Marshal(broadcast)
					wsHub.Broadcast(data)
				}
				if err != nil {
					file.Close()
					time.Sleep(2 * time.Second)
					break
				}
			}
		}
	}()
}

func parseLogLine(line string) LogEntry {
	entry := LogEntry{Raw: line}
	parts := strings.SplitN(line, " ", 3)
	if len(parts) >= 3 {
		entry.Time = parts[0]
		entry.Level = parts[1]
		entry.Message = parts[2]
	} else if len(parts) == 2 {
		entry.Time = parts[0]
		entry.Message = parts[1]
	} else {
		entry.Message = line
	}
	return entry
}

// ============ Remote Auto Reconnect ============

func startRemoteReconnect() {
	ticker := time.NewTicker(30 * time.Second)
	go func() {
		var servers []remote.Server
		db.GetJSON("remote_servers", &servers)
		for range ticker.C {
			for _, srv := range servers {
				if srv.Connected && remote.Mgr.GetServer(srv.ID) == nil {
					// Lost connection, try reconnect
					srv.Connected = false
					if err := remote.Mgr.Connect(&srv); err == nil {
						broadcastRemoteStatus(srv.ID, true)
					}
				}
			}
		}
	}()
}

func broadcastRemoteStatus(id string, connected bool) {
	data, _ := json.Marshal(map[string]interface{}{"type": "remote_status", "serverId": id, "connected": connected})
	wsHub.Broadcast(data)
}

// ============ HTTP Handlers ============

func jsonWrite(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.Encode(v)
}

func jsonRead(r *http.Request, v interface{}) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 50<<20))
	if err != nil {
		return err
	}
	return json.Unmarshal(body, v)
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	typ := r.URL.Query().Get("type")
	if typ == "" {
		typ = "main"
	}
	c := &WSClient{conn: conn, send: make(chan []byte, 256), typ: typ}
	wsHub.register <- c

	go func() {
		defer func() { wsHub.unregister <- c }()
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				break
			}
		}
	}()
}

func handleAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method == "OPTIONS" {
		w.WriteHeader(200)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	path := strings.TrimPrefix(r.URL.Path, "/api")
	method := r.Method

	switch {
	// --- Settings ---
	case path == "/settings" && method == "GET":
		if val, _ := db.Get("settings"); val != "" {
			w.Write([]byte(val))
		} else {
			jsonWrite(w, config.Load())
		}
	case path == "/settings" && (method == "PUT" || method == "POST"):
		body, _ := io.ReadAll(io.LimitReader(r.Body, 50<<20))
		db.Set("settings", string(body))
		jsonWrite(w, map[string]string{"status": "ok"})

	// --- Servers ---
	case path == "/servers" && method == "GET":
		var servers []remote.Server
		db.GetJSON("remote_servers", &servers)
		if servers == nil {
			servers = []remote.Server{}
		}
		// Mark connection status
		for i := range servers {
			servers[i].Connected = remote.Mgr.IsConnected(servers[i].ID)
		}
		jsonWrite(w, servers)

	case path == "/servers" && (method == "POST" || method == "PUT"):
		var srv remote.Server
		if err := jsonRead(r, &srv); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		var servers []remote.Server
		db.GetJSON("remote_servers", &servers)
		found := false
		for i := range servers {
			if servers[i].ID == srv.ID {
				servers[i] = srv
				found = true
				break
			}
		}
		if !found {
			servers = append(servers, srv)
		}
		db.SetJSON("remote_servers", servers)
		jsonWrite(w, srv)

	case path == "/servers" && method == "DELETE":
		id := r.URL.Query().Get("id")
		var servers []remote.Server
		db.GetJSON("remote_servers", &servers)
		var filtered []remote.Server
		for _, s := range servers {
			if s.ID != id {
				filtered = append(filtered, s)
			}
		}
		db.SetJSON("remote_servers", filtered)
		jsonWrite(w, map[string]string{"status": "ok"})

	case strings.HasPrefix(path, "/servers/"):
		parts := strings.SplitN(strings.TrimPrefix(path, "/servers/"), "/", 2)
		srv := remote.Mgr.GetServer(parts[0])
		action := ""
		if len(parts) > 1 {
			action = parts[1]
		}
		handleServerAction(w, r, srv, action)

	// --- Monitor ---
	case path == "/monitor/stats" && method == "GET":
		jsonWrite(w, collectLocalStats())

	case path == "/monitor/history" && method == "GET":
		monitorHistoryMu.RLock()
		defer monitorHistoryMu.RUnlock()
		jsonWrite(w, monitorHistory)

	// --- Logs ---
	case path == "/logs/sources" && method == "GET":
		logSourcesMu.RLock()
		defer logSourcesMu.RUnlock()
		var result []LogSource
		for _, s := range logSources {
			result = append(result, *s)
		}
		jsonWrite(w, result)

	case path == "/logs/sources" && (method == "POST" || method == "PUT"):
		var src LogSource
		if err := jsonRead(r, &src); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		src.Offsets = make(map[string]int64)
		logSourcesMu.Lock()
		logSources[src.ID] = &src
		logSourcesMu.Unlock()
		watchLog(&src)
		jsonWrite(w, src)

	case path == "/logs/sources" && method == "DELETE":
		id := r.URL.Query().Get("id")
		logSourcesMu.Lock()
		delete(logSources, id)
		logSourcesMu.Unlock()
		jsonWrite(w, map[string]string{"status": "ok"})

	case strings.HasPrefix(path, "/logs/"):
		parts := strings.SplitN(strings.TrimPrefix(path, "/logs/"), "/", 2)
		logSourcesMu.RLock()
		src := logSources[parts[0]]
		logSourcesMu.RUnlock()
		if src == nil {
			http.Error(w, "source not found", 404)
			return
		}
		action := parts[1]
		handleLogAction(w, r, src, action)

	// --- AI ---
	case path == "/ai/chat" && method == "POST":
		handleAIChat(w, r)
	case path == "/ai/chat/stream" && method == "POST":
		handleAIStream(w, r)
	case path == "/ai/models" && method == "GET":
		handleOllamaModels(w, r)
	case path == "/ai/analyze" && method == "POST":
		handleAIAnalyze(w, r)
	case path == "/ai/fix" && method == "POST":
		handleAIFix(w, r)

	// --- Docker ---
	case path == "/docker/containers" && method == "GET":
		handleDockerList(w, r)
	case path == "/docker/containers" && method == "POST":
		handleDockerCreate(w, r)
	case strings.HasPrefix(path, "/docker/") && len(strings.Split(strings.TrimPrefix(path, "/docker/"), "/")) >= 1:
		parts := strings.SplitN(strings.TrimPrefix(path, "/docker/"), "/", 2)
		if len(parts) < 2 {
			http.NotFound(w, r)
			return
		}
		handleDockerAction(w, r, parts[0], parts[1])

	// --- Memory ---
	case path == "/memory" && method == "GET":
		var mems []map[string]string
		db.GetJSON("assistant_memory", &mems)
		if mems == nil {
			mems = []map[string]string{}
		}
		jsonWrite(w, mems)
	case path == "/memory" && method == "POST":
		var m map[string]string
		if err := jsonRead(r, &m); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		var mems []map[string]string
		db.GetJSON("assistant_memory", &mems)
		if mems == nil {
			mems = []map[string]string{}
		}
		mems = append(mems, m)
		db.SetJSON("assistant_memory", mems)
		jsonWrite(w, m)
	case path == "/memory" && method == "DELETE":
		id := r.URL.Query().Get("id")
		var mems []map[string]string
		db.GetJSON("assistant_memory", &mems)
		var filtered []map[string]string
		for _, m := range mems {
			if m["id"] != id {
				filtered = append(filtered, m)
			}
		}
		db.SetJSON("assistant_memory", filtered)
		jsonWrite(w, map[string]string{"status": "ok"})

	// --- Health ---
	case path == "/health" && method == "GET":
		jsonWrite(w, map[string]interface{}{"status": "ok", "uptime": time.Now().Unix()})

	default:
		http.NotFound(w, r)
	}
}

// ============ Server Action Handlers ============

func handleServerAction(w http.ResponseWriter, r *http.Request, srv *remote.Server, action string) {
	if srv == nil {
		http.Error(w, "server not found", 404)
		return
	}

	switch action {
	case "connect":
		if err := remote.Mgr.Connect(srv); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		broadcastRemoteStatus(srv.ID, true)
		jsonWrite(w, srv)

	case "disconnect":
		remote.Mgr.Disconnect(srv)
		broadcastRemoteStatus(srv.ID, false)
		jsonWrite(w, map[string]string{"status": "ok"})

	case "test":
		err := remote.TestConnection(srv.Host, srv.Port, srv.User, srv.Password)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		jsonWrite(w, map[string]string{"status": "ok"})

	case "stats":
		stats := srv.GetStats()
		jsonWrite(w, stats)

	case "files":
		path := r.URL.Query().Get("path")
		if path == "" {
			path = "/"
		}
		out, err := srv.ListFiles(path)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		var files []map[string]string
		for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "|", 3)
			if len(parts) >= 2 {
				var size int64
				fmt.Sscanf(parts[1], "%d", &size)
				files = append(files, map[string]string{"name": parts[0], "size": fmt.Sprintf("%d", size)})
			}
		}
		jsonWrite(w, files)

	case "logs":
		path := r.URL.Query().Get("path")
		if path == "" {
			path = "/var/log/syslog"
		}
		lines := 200
		fmt.Sscanf(r.URL.Query().Get("lines"), "%d", &lines)
		out, err := srv.ReadLog(path, lines)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		jsonWrite(w, map[string]string{"content": out})

	case "read":
		path := r.URL.Query().Get("path")
		if path == "" {
			http.Error(w, "path required", 400)
			return
		}
		var offset, limit int64 = 0, 1 << 20
		fmt.Sscanf(r.URL.Query().Get("offset"), "%d", &offset)
		fmt.Sscanf(r.URL.Query().Get("limit"), "%d", &limit)
		content, err := srv.ReadFile(path, offset, limit)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		jsonWrite(w, map[string]string{"content": content})

	case "write":
		path := r.URL.Query().Get("path")
		content := r.URL.Query().Get("content")
		if path == "" {
			http.Error(w, "path required", 400)
			return
		}
		if err := srv.WriteFile(path, content); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		jsonWrite(w, map[string]string{"status": "ok"})

	case "shell":
		srv.HandleShell(w, r)

	case "exec":
		cmd := r.URL.Query().Get("cmd")
		if cmd == "" {
			http.Error(w, "cmd required", 400)
			return
		}
		out, err := srv.Exec(cmd)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		jsonWrite(w, map[string]string{"output": out})

	default:
		http.Error(w, "unknown action: "+action, 400)
	}
}

// ============ Log Action Handlers ============

func handleLogAction(w http.ResponseWriter, r *http.Request, src *LogSource, action string) {
	switch action {
	case "entries":
		src.mu.RLock()
		defer src.mu.RUnlock()
		jsonWrite(w, src.Entries)

	default:
		http.NotFound(w, r)
	}
}

// ============ AI Handlers ============

func handleAIChat(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Messages []map[string]string `json:"messages"`
		Model    string               `json:"model"`
		Stream   bool                 `json:"stream"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if req.Model == "" {
		req.Model = "qwen2.5:7b"
	}

	cfg := config.Load()
	payload := map[string]interface{}{
		"model":    req.Model,
		"messages": req.Messages,
		"stream":   false,
	}
	body, _ := json.Marshal(payload)

	resp, err := http.Post(cfg.AIEndpoint+"/chat/completions", "application/json", strings.NewReader(string(body)))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer resp.Body.Close()
	result, _ := io.ReadAll(resp.Body)
	w.Header().Set("Content-Type", "application/json")
	w.Write(result)
}

func handleAIStream(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Messages []map[string]string `json:"messages"`
		Model    string               `json:"model"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if req.Model == "" {
		req.Model = "qwen2.5:7b"
	}

	cfg := config.Load()
	payload := map[string]interface{}{
		"model":    req.Model,
		"messages": req.Messages,
		"stream":   true,
	}
	body, _ := json.Marshal(payload)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(200)

	resp, err := http.Post(cfg.AIEndpoint+"/chat/completions", "application/json", strings.NewReader(string(body)))
	if err != nil {
		return
	}
	defer resp.Body.Close()

	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}
	io.Copy(w, resp.Body)
	flusher.Flush()
}

func handleOllamaModels(w http.ResponseWriter, r *http.Request) {
	cfg := config.Load()
	resp, err := http.Get(cfg.AIEndpoint + "/api/tags")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer resp.Body.Close()
	io.Copy(w, resp.Body)
}

func handleAIAnalyze(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Logs    string `json:"logs"`
		Context string `json:"context"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	cfg := config.Load()
	systemPrompt := "你是一位资深运维工程师。请分析以下日志，找出可能的错误原因并给出修复建议。日志：\n" + req.Logs
	if req.Context != "" {
		systemPrompt += "\n上下文信息：" + req.Context
	}
	payload := map[string]interface{}{
		"model":    cfg.AIModel,
		"messages": []map[string]string{{"role": "system", "content": systemPrompt}, {"role": "user", "content": "请分析"}},
		"stream":   false,
	}
	body, _ := json.Marshal(payload)
	resp, err := http.Post(cfg.AIEndpoint+"/chat/completions", "application/json", strings.NewReader(string(body)))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer resp.Body.Close()
	result, _ := io.ReadAll(resp.Body)
	w.Header().Set("Content-Type", "application/json")
	w.Write(result)
}

func handleAIFix(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
		Error string `json:"error"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	cfg := config.Load()
	systemPrompt := "你是一位资深运维工程师。以下代码有错误：" + req.Code + "\n错误信息：" + req.Error + "\n请给出修复后的代码。"
	payload := map[string]interface{}{
		"model":    cfg.AIModel,
		"messages": []map[string]string{{"role": "system", "content": systemPrompt}, {"role": "user", "content": "请修复代码"}},
		"stream":   false,
	}
	body, _ := json.Marshal(payload)
	resp, err := http.Post(cfg.AIEndpoint+"/chat/completions", "application/json", strings.NewReader(string(body)))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer resp.Body.Close()
	result, _ := io.ReadAll(resp.Body)
	w.Header().Set("Content-Type", "application/json")
	w.Write(result)
}

// ============ Docker Handlers ============

func handleDockerList(w http.ResponseWriter, r *http.Request) {
	out, err := exec.Command("docker", "ps", "-a", "--format", "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}").Output()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	var containers []map[string]string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 5)
		if len(parts) >= 4 {
			containers = append(containers, map[string]string{
				"id":    parts[0],
				"name":  parts[1],
				"image": parts[2],
				"status": parts[3],
				"ports": parts[4],
			})
		}
	}
	jsonWrite(w, containers)
}

func handleDockerCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Image string `json:"image"`
		Name  string `json:"name"`
		Ports string `json:"ports"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	args := []string{"run", "-d"}
	if req.Name != "" {
		args = append(args, "--name", req.Name)
	}
	if req.Ports != "" {
		args = append(args, "-p", req.Ports)
	}
	args = append(args, req.Image)
	out, err := exec.Command("docker", args...).Output()
	if err != nil {
		http.Error(w, string(out), 500)
		return
	}
	jsonWrite(w, map[string]string{"id": strings.TrimSpace(string(out))})
}

func handleDockerAction(w http.ResponseWriter, r *http.Request, id, action string) {
	switch action {
	case "start", "stop", "restart", "remove", "logs":
		out, err := exec.Command("docker", action, id).Output()
		if err != nil {
			http.Error(w, string(out), 500)
			return
		}
		jsonWrite(w, map[string]string{"output": string(out)})
	default:
		http.NotFound(w, r)
	}
}

// ============ Main ============

func main() {
	cfg := config.Load()

	// Init DB
	if err := db.Init(cfg); err != nil {
		log.Fatalf("[DB] Init failed: %v", err)
	}

	// Start services
	go wsHub.Run()
	startMonitor()
	startRemoteReconnect()

	// Routes
	http.HandleFunc("/ws", handleWS)
	http.HandleFunc("/api/", handleAPI)

	addr := fmt.Sprintf(":%d", cfg.Port)
	fmt.Printf("🚀 OpenLog server (Go) running on http://localhost:%d\n", cfg.Port)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal(err)
	}
}
