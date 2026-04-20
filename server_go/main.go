package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
	"openlog/config"
	"openlog/db"
	"openlog/docker"
	"openlog/remote"
	"openlog/services"
)

// ============ Models ============

type CPUInfo struct {
	Load  float64  `json:"load"`
	Cores []float64 `json:"cores"`
}

type MonitorStats struct {
	CPU       CPUInfo          `json:"cpu"`
	Memory    MemoryInfo       `json:"memory"`
	Disk      []DiskInfo       `json:"disk"`
	Network   []NetworkInfo    `json:"network"`
	Processes []ProcessInfo    `json:"processes"`
	GPUs      []GPUInfo        `json:"gpus"`
}

type MemoryInfo struct {
	Used  uint64  `json:"used"`
	Total uint64  `json:"total"`
	Free  uint64  `json:"free"`
}

type DiskInfo struct {
	Name       string  `json:"name"`
	Used       uint64  `json:"used"`
	Total      uint64  `json:"total"`
	UsePercent float64 `json:"usePercent"`
}

type NetworkInfo struct {
	Iface string `json:"iface"`
	Rx    uint64 `json:"rx"`
	Tx    uint64 `json:"tx"`
}

type ProcessInfo struct {
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
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Level     string `json:"level"`
	Message   string `json:"message"`
	Source    string `json:"source"`
	Metadata  string `json:"metadata"`
}

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
				select {
				case c.send <- msg:
				default:
					close(c.send)
					delete(h.clients, c)
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

// ============ Logs Storage ============

var logs []LogEntry
var logsMu sync.RWMutex
const MaxLogs = 10000

func saveLog(log LogEntry) {
	logsMu.Lock()
	defer logsMu.Unlock()
	logs = append([]LogEntry{log}, logs...)
	if len(logs) > MaxLogs {
		logs = logs[:MaxLogs]
	}
}

// ============ Monitor ============

var monitorHistory []MonitorStats
var monitorHistoryMu sync.RWMutex
const MaxHistoryLen = 1000

func collectLocalStats() MonitorStats {
	var s MonitorStats

	// CPU
	if pct, err := cpu.Percent(0, false); err == nil && len(pct) > 0 {
		s.CPU.Load = pct[0]
	}
	if cores, err := cpu.Percent(0, true); err == nil {
		s.CPU.Cores = cores
	}

	// Memory
	if mi, err := mem.VirtualMemory(); err == nil {
		s.Memory = MemoryInfo{Used: mi.Used, Total: mi.Total, Free: mi.Free}
	}

	// Disk
	if di, err := disk.Partitions(false); err == nil {
		for _, p := range di {
			if du, err := disk.Usage(p.Mountpoint); err == nil {
				s.Disk = append(s.Disk, DiskInfo{
					Name:       p.Mountpoint,
					Used:       du.Used,
					Total:      du.Total,
					UsePercent: du.UsedPercent,
				})
			}
		}
	}

	// Network
	if ni, err := net.IOCounters(true); err == nil {
		for _, n := range ni {
			s.Network = append(s.Network, NetworkInfo{
				Iface: n.Name,
				Rx:    n.BytesRecv,
				Tx:    n.BytesSent,
			})
		}
	}

	// Processes (top 10 by CPU)
	if procs, err := process.Processes(); err == nil {
		var procList []ProcessInfo
		for _, p := range procs {
			name, _ := p.Name()
			cpuPct, _ := p.CPUPercent()
			memPct, _ := p.MemoryPercent()
			procList = append(procList, ProcessInfo{
				PID:  p.Pid,
				Name: name,
				CPU:  cpuPct,
				Mem:  float64(memPct),
			})
		}
		// Sort by CPU
		for i := 0; i < len(procList); i++ {
			for j := i + 1; j < len(procList); j++ {
				if procList[j].CPU > procList[i].CPU {
					procList[i], procList[j] = procList[j], procList[i]
				}
			}
		}
		if len(procList) > 10 {
			procList = procList[:10]
		}
		s.Processes = procList
	}

	// GPU
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
			data, _ := json.Marshal(map[string]interface{}{"type": "monitor", "data": s})
			wsHub.Broadcast(data)
		}
	}()
}

// ============ Helpers ============

func uuid() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

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

func getSettings() map[string]interface{} {
	var settings map[string]interface{}
	if val, _ := db.Get("settings"); val != "" {
		json.Unmarshal([]byte(val), &settings)
	}
	if settings == nil {
		settings = map[string]interface{}{
			"openaiApiKey":   "",
			"openaiBaseUrl":  "http://localhost:11434/v1",
			"model":          "qwen2.5:7b",
			"logPath":        "",
			"watchFiles":     "*.log",
			"refreshInterval": "5000",
			"autoAnalysis":   true,
			"thinkingEnabled": false,
			"watchSources":   []interface{}{},
			"dockerSources":  []interface{}{},
		}
	}
	return settings
}

func saveSettings(settings map[string]interface{}) {
	data, _ := json.Marshal(settings)
	db.Set("settings", string(data))
}

func getAIConfig() (baseUrl, model, apiKey string) {
	settings := getSettings()
	if v, ok := settings["openaiBaseUrl"].(string); ok {
		baseUrl = v
	} else {
		baseUrl = "http://localhost:11434/v1"
	}
	if v, ok := settings["model"].(string); ok {
		model = v
	} else {
		model = "qwen2.5:7b"
	}
	if v, ok := settings["openaiApiKey"].(string); ok {
		apiKey = v
	}
	return
}

func getThinkingEnabled() bool {
	settings := getSettings()
	if v, ok := settings["thinkingEnabled"].(bool); ok {
		return v
	}
	return false
}

// ============ WebSocket Handler ============

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

// ============ API Handler ============

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
	// --- Health ---
	case path == "/health":
		jsonWrite(w, map[string]interface{}{"status": "ok", "uptime": time.Now().Unix()})

	// --- Settings ---
	case path == "/settings" && method == "GET":
		jsonWrite(w, getSettings())
	case path == "/settings" && method == "PUT":
		var settings map[string]interface{}
		if err := jsonRead(r, &settings); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		saveSettings(settings)
		jsonWrite(w, map[string]string{"success": "true"})

	// --- Logs ---
	case path == "/logs" && method == "GET":
		handleGetLogs(w, r)
	case path == "/logs" && method == "DELETE":
		logsMu.Lock()
		logs = nil
		logsMu.Unlock()
		jsonWrite(w, map[string]bool{"success": true})
	case path == "/logs/files" && method == "GET":
		handleGetLogFiles(w, r)
	case path == "/logs/analyze" && method == "POST":
		handleAIAnalyze(w, r)
	case path == "/logs/fix" && method == "POST":
		handleAIFix(w, r)
	case path == "/logs/generate-sample" && method == "POST":
		handleGenerateSample(w, r)

	// --- Models ---
	case path == "/models/ollama" && method == "GET":
		handleOllamaModels(w, r)

	// --- Analysis ---
	case path == "/analysis/status" && method == "GET":
		jsonWrite(w, services.AnalysisMgr.GetQueueStatus())
	case path == "/analysis/trigger" && method == "POST":
		handleAnalysisTrigger(w, r)
	case path == "/analysis/history" && method == "GET":
		handleAnalysisHistory(w, r)
	case path == "/analysis/history" && method == "DELETE":
		services.AnalysisMgr.ClearHistory()
		jsonWrite(w, map[string]bool{"success": true})
	case strings.HasPrefix(path, "/analysis/history/"):
		handleAnalysisHistoryDelete(w, r, strings.TrimPrefix(path, "/analysis/history/"))

	// --- Chat ---
	case path == "/chat" && method == "POST":
		handleChat(w, r)

	// --- Monitor ---
	case path == "/monitor/stats" && method == "GET":
		jsonWrite(w, collectLocalStats())
	case path == "/monitor/history" && method == "GET":
		limit := 100
		fmt.Sscanf(r.URL.Query().Get("limit"), "%d", &limit)
		monitorHistoryMu.RLock()
		result := monitorHistory
		if len(result) > limit {
			result = result[:limit]
		}
		monitorHistoryMu.RUnlock()
		jsonWrite(w, result)

	// --- Docker ---
	case path == "/docker/ping" && method == "POST":
		handleDockerPing(w, r)
	case path == "/docker/containers" && method == "GET":
		handleDockerList(w, r)
	case strings.HasPrefix(path, "/docker/containers/"):
		handleDockerContainer(w, r, path)
	case path == "/docker/logs/batch" && method == "POST":
		handleDockerLogsBatch(w, r)
	case path == "/docker/analyze/batch" && method == "POST":
		handleDockerAnalyzeBatch(w, r)
	case strings.HasPrefix(path, "/docker/trace/"):
		handleDockerTrace(w, r, path)
	case strings.HasPrefix(path, "/docker/"):
		handleDockerAction(w, r, path)

	// --- Remote Servers ---
	case path == "/remote/servers" && method == "GET":
		handleRemoteList(w, r)
	case path == "/remote/servers" && method == "POST":
		handleRemoteAdd(w, r)
	case path == "/remote/test" && method == "POST":
		handleRemoteTest(w, r)
	case strings.HasPrefix(path, "/remote/servers/"):
		handleRemoteServer(w, r, path)

	// --- Assistant Memory ---
	case path == "/assistant/memory" && method == "GET":
		handleMemoryList(w, r)
	case path == "/assistant/memory" && method == "POST":
		handleMemorySave(w, r)
	case strings.HasPrefix(path, "/assistant/memory/"):
		handleMemoryDelete(w, r, strings.TrimPrefix(path, "/assistant/memory/"))

	default:
		http.NotFound(w, r)
	}
}

// ============ Log Handlers ============

func handleGetLogs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	level := q.Get("level")
	source := q.Get("source")
	search := q.Get("search")
	limit := 100
	offset := 0
	fmt.Sscanf(q.Get("limit"), "%d", &limit)
	fmt.Sscanf(q.Get("offset"), "%d", &offset)

	logsMu.RLock()
	result := make([]LogEntry, 0)
	for _, l := range logs {
		if level != "" && l.Level != level {
			continue
		}
		if source != "" && l.Source != source {
			continue
		}
		if search != "" && !strings.Contains(strings.ToLower(l.Message), strings.ToLower(search)) {
			continue
		}
		result = append(result, l)
	}
	total := len(result)
	if offset < len(result) {
		result = result[offset:]
	}
	if limit < len(result) {
		result = result[:limit]
	}
	logsMu.RUnlock()

	jsonWrite(w, map[string]interface{}{"logs": result, "total": total})
}

func handleGetLogFiles(w http.ResponseWriter, r *http.Request) {
	settings := getSettings()
	sources, _ := settings["watchSources"].([]interface{})

	var files = make([]map[string]interface{}, 0)
	for _, s := range sources {
		src, ok := s.(map[string]interface{})
		if !ok {
			continue
		}
		logPath, _ := src["path"].(string)
		if logPath == "" {
			continue
		}
		_ = filepath.Walk(logPath, func(filePath string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || !strings.HasSuffix(filePath, ".log") {
				return nil
			}
			files = append(files, map[string]interface{}{
				"name": filepath.Base(filePath),
				"path": filePath,
				"size": info.Size(),
			})
			return nil
		})
	}
	jsonWrite(w, files)
}

func handleGenerateSample(w http.ResponseWriter, r *http.Request) {
	levels := []string{"INFO", "WARN", "ERROR", "DEBUG"}
	messages := []string{
		"Server started on port 3000",
		"Database connection established",
		"User login successful",
		"High memory usage detected: 85%",
		"Connection timeout to database",
		"Failed to parse JSON payload",
		"Rate limit exceeded for IP 192.168.1.1",
	}

	count := 5 + time.Now().UnixNano()%5
	for i := 0; i < int(count); i++ {
		level := levels[time.Now().UnixNano()%4]
		msg := messages[time.Now().UnixNano()%int64(len(messages))]
		log := LogEntry{
			ID:        uuid(),
			Timestamp: time.Now().Format(time.RFC3339),
			Level:     level,
			Message:   msg,
			Source:    "sample.log",
			Metadata:  "{}",
		}
		saveLog(log)
		wsHub.Broadcast([]byte(fmt.Sprintf(`{"type":"log","data":%s}`, mustMarshal(log))))
	}
	jsonWrite(w, map[string]int{"count": int(count)})
}

// ============ AI Handlers ============

func handleAIAnalyze(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Logs  []LogEntry `json:"logs"`
		Prompt string    `json:"prompt"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	baseUrl, model, _ := getAIConfig()
	prompt := req.Prompt
	if prompt == "" {
		logText := ""
		for _, l := range req.Logs {
			logText += fmt.Sprintf("[%s] [%s] %s\n", l.Timestamp, l.Level, l.Message)
		}
		prompt = fmt.Sprintf("你是一个专业的运维工程师和日志分析专家。请分析以下日志，找出可能存在的问题并提供修复建议。\n\n%s", logText)
	}

	resp, err := callLLM(baseUrl, model, prompt)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	jsonWrite(w, map[string]string{"analysis": resp})
}

func handleAIFix(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ErrorLog    string `json:"errorLog"`
		CodeContext string `json:"codeContext"`
		FilePath    string `json:"filePath"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	baseUrl, model, _ := getAIConfig()
	prompt := fmt.Sprintf("你是一个专业的全栈开发工程师。以下代码有错误：\n%s\n错误信息：%s\n请给出修复后的代码。", req.CodeContext, req.ErrorLog)

	resp, err := callLLM(baseUrl, model, prompt)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	jsonWrite(w, map[string]string{"fix": resp})
}

func handleOllamaModels(w http.ResponseWriter, r *http.Request) {
	baseUrl, _, _ := getAIConfig()
	// Only local Ollama
	if !strings.Contains(baseUrl, "localhost") && !strings.Contains(baseUrl, "127.0.0.1") {
		jsonWrite(w, map[string]interface{}{"models": []string{}, "error": "仅支持本地 Ollama"})
		return
	}

	resp, err := http.Get(strings.Replace(baseUrl, "/v1", "/api/tags", 1))
	if err != nil {
		jsonWrite(w, map[string]interface{}{"models": []string{}, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	io.Copy(w, resp.Body)
}

func handleAnalysisTrigger(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Message    string `json:"message"`
		SourceID   string `json:"sourceId"`
		SourceName string `json:"sourceName"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if req.SourceID == "" {
		req.SourceID = "manual"
	}
	if req.SourceName == "" {
		req.SourceName = "手动触发"
	}

	entry := services.LogEntry{
		Time:    time.Now().Format(time.RFC3339),
		Level:   "ERROR",
		Message: req.Message,
		Raw:     req.Message,
	}
	record := services.AnalysisMgr.TriggerManual(req.Message, req.SourceID, req.SourceName)
	jsonWrite(w, map[string]interface{}{"success": true, "record": record, "log": entry})
}

func handleAnalysisHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sourceID := q.Get("sourceId")
	status := q.Get("status")
	limit := 50
	offset := 0
	fmt.Sscanf(q.Get("limit"), "%d", &limit)
	fmt.Sscanf(q.Get("offset"), "%d", &offset)

	records := services.AnalysisMgr.GetHistory(sourceID, status, limit, offset)
	jsonWrite(w, map[string]interface{}{"records": records})
}

func handleAnalysisHistoryDelete(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method == "DELETE" {
		if id == "" {
			services.AnalysisMgr.ClearHistory()
		} else {
			services.AnalysisMgr.DeleteHistory(id)
		}
		jsonWrite(w, map[string]bool{"success": true})
	}
}

func handleChat(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Messages []map[string]string `json:"messages"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	baseUrl, model, _ := getAIConfig()

	// System prompt
	messages := append([]map[string]string{{
		"role":    "system",
		"content": "你是一个专业的运维工程师和技术支持助手。你的职责是帮助运维人员排查服务器、网络、数据库、中间件等问题，提供清晰、可操作的解决方案。回复使用与用户相同的语言。",
	}}, req.Messages...)

	// Stream SSE
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	payload := map[string]interface{}{
		"model":    model,
		"messages": messages,
		"stream":   true,
	}
	body, _ := json.Marshal(payload)

	resp, err := http.Post(baseUrl+"/chat/completions", "application/json", strings.NewReader(string(body)))
	if err != nil {
		return
	}
	defer resp.Body.Close()

	flusher, _ := w.(http.Flusher)
	filter := services.NewThinkingStreamFilter(getThinkingEnabled())

	reader := bufio.NewReader(resp.Body)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			break
		}
		if strings.HasPrefix(line, "data: ") {
			data := strings.TrimPrefix(line, "data: ")
			if data == "[DONE]\n" || data == "[DONE]" {
				if remaining := filter.Flush(); remaining != "" {
					fmt.Fprintf(w, "data: %s\n\n", remaining)
					flusher.Flush()
				}
				fmt.Fprintf(w, "data: [DONE]\n\n")
				flusher.Flush()
				break
			}
			var sse struct {
				Choices []struct {
					Delta struct {
						Content string `json:"content"`
					} `json:"delta"`
				} `json:"choices"`
			}
			if json.Unmarshal([]byte(data), &sse) == nil && len(sse.Choices) > 0 {
				content := sse.Choices[0].Delta.Content
				filtered := filter.Process(content)
				if filtered != "" {
					fmt.Fprintf(w, "data: {\"content\":%q}\n\n", filtered)
					flusher.Flush()
				}
			}
		}
	}
}

func callLLM(baseUrl, model, prompt string) (string, error) {
	payload := map[string]interface{}{
		"model": model,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
		"stream": false,
	}
	body, _ := json.Marshal(payload)

	resp, err := http.Post(baseUrl+"/chat/completions", "application/json", strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	if len(result.Choices) > 0 {
		return services.StripThinking(result.Choices[0].Message.Content, getThinkingEnabled()), nil
	}
	return "", fmt.Errorf("no response")
}

// ============ Docker Handlers ============

func handleDockerPing(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SourceID string             `json:"sourceId"`
		Config   docker.DockerConfig `json:"config"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if req.SourceID == "" {
		req.SourceID = "local"
	}

	info, err := docker.PingDocker(req.SourceID, req.Config)
	if err != nil {
		jsonWrite(w, map[string]interface{}{"success": false, "error": err.Error()})
		return
	}
	jsonWrite(w, map[string]interface{}{"success": true, "info": info})
}

func handleDockerList(w http.ResponseWriter, r *http.Request) {
	settings := getSettings()
	sources, _ := settings["dockerSources"].([]interface{})

	var results []map[string]interface{}
	for _, s := range sources {
		src, ok := s.(map[string]interface{})
		if !ok {
			continue
		}
		enabled, _ := src["enabled"].(bool)
		if !enabled {
			continue
		}
		sourceID, _ := src["id"].(string)
		sourceName, _ := src["name"].(string)
		if sourceID == "" {
			continue
		}

		config := dockerConfigFromMap(src)
		containers, err := docker.ListContainers(sourceID, config)
		if err != nil {
			results = append(results, map[string]interface{}{
				"sourceId":   sourceID,
				"sourceName": sourceName,
				"error":      err.Error(),
				"containers": []docker.ContainerInfo{},
			})
		} else {
			results = append(results, map[string]interface{}{
				"sourceId":   sourceID,
				"sourceName": sourceName,
				"containers": containers,
			})
		}
	}
	jsonWrite(w, map[string]interface{}{"sources": results})
}

func dockerConfigFromMap(m map[string]interface{}) docker.DockerConfig {
	var cfg docker.DockerConfig
	if v, ok := m["socketPath"].(string); ok {
		cfg.SocketPath = v
	}
	if v, ok := m["host"].(string); ok {
		cfg.Host = v
	}
	if v, ok := m["port"].(float64); ok {
		cfg.Port = int(v)
	}
	if v, ok := m["tls"].(bool); ok {
		cfg.TLS = v
	}
	if v, ok := m["ca"].(string); ok {
		cfg.CACert = v
	}
	if v, ok := m["cert"].(string); ok {
		cfg.Cert = v
	}
	if v, ok := m["key"].(string); ok {
		cfg.Key = v
	}
	return cfg
}

func handleDockerContainer(w http.ResponseWriter, r *http.Request, path string) {
	// /docker/containers/:sourceId/:containerId or /docker/containers/:sourceId/:containerId/logs
	parts := strings.Split(strings.TrimPrefix(path, "/docker/containers/"), "/")
	if len(parts) < 2 {
		http.Error(w, "invalid path", 400)
		return
	}
	sourceID := parts[0]
	containerID := parts[1]
	action := ""
	if len(parts) > 2 {
		action = parts[2]
	}

	config := getDockerConfig(sourceID)

	switch action {
	case "logs":
		tail := 200
		fmt.Sscanf(r.URL.Query().Get("tail"), "%d", &tail)
		logs, err := docker.GetContainerLogs(sourceID, containerID, config, docker.LogOptions{Tail: tail})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		jsonWrite(w, map[string]interface{}{"logs": logs, "containerId": containerID, "sourceId": sourceID})
	default:
		// Get container info
		containers, err := docker.ListContainers(sourceID, config)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		for _, c := range containers {
			if c.ID == containerID || c.ShortID == containerID {
				jsonWrite(w, c)
				return
			}
		}
		http.Error(w, "container not found", 404)
	}
}

func handleDockerLogsBatch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Containers []struct {
			SourceID      string `json:"sourceId"`
			ContainerID   string `json:"containerId"`
			ContainerName string `json:"name"`
		} `json:"containers"`
		Tail int `json:"tail"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if req.Tail == 0 {
		req.Tail = 200
	}

	var results []map[string]interface{}
	for _, c := range req.Containers {
		config := getDockerConfig(c.SourceID)
		logs, err := docker.GetContainerLogs(c.SourceID, c.ContainerID, config, docker.LogOptions{Tail: req.Tail})
		if err != nil {
			results = append(results, map[string]interface{}{
				"sourceId":      c.SourceID,
				"containerId":   c.ContainerID,
				"containerName": c.ContainerName,
				"logs":          []docker.LogLine{},
				"ok":            false,
				"error":         err.Error(),
			})
		} else {
			results = append(results, map[string]interface{}{
				"sourceId":      c.SourceID,
				"containerId":   c.ContainerID,
				"containerName": c.ContainerName,
				"logs":          logs,
				"ok":            true,
			})
		}
	}
	jsonWrite(w, map[string]interface{}{"results": results})
}

func handleDockerAnalyzeBatch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Containers []struct {
			SourceID      string `json:"sourceId"`
			ContainerID   string `json:"containerId"`
			ContainerName string `json:"name"`
		} `json:"containers"`
		Prompt string `json:"prompt"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	// Get logs first
	var allLogs []string
	for _, c := range req.Containers {
		config := getDockerConfig(c.SourceID)
		logs, err := docker.GetContainerLogs(c.SourceID, c.ContainerID, config, docker.LogOptions{Tail: 200})
		if err == nil {
			var lines []string
			for _, l := range logs {
				lines = append(lines, fmt.Sprintf("[%s] [%s] %s", l.Timestamp, l.Stream, l.Line))
			}
			allLogs = append(allLogs, fmt.Sprintf("=== %s ===\n%s", c.ContainerName, strings.Join(lines, "\n")))
		}
	}

	// Analyze
	baseUrl, model, _ := getAIConfig()
	prompt := req.Prompt
	if prompt == "" {
		prompt = fmt.Sprintf("你是运维工程师，正在进行多容器日志联合会诊。\n\n%s\n\n请分析：\n1. 每个服务的健康状态\n2. 哪些服务出现 ERROR/异常\n3. 给出修复建议", strings.Join(allLogs, "\n\n"))
	}

	// Return logs immediately, analyze in background
	jsonWrite(w, map[string]string{"message": "日志已获取，分析中..."})

	go func() {
		resp, err := callLLM(baseUrl, model, prompt)
		if err != nil {
			wsHub.Broadcast([]byte(fmt.Sprintf(`{"type":"docker_batch_analysis","status":"error","message":%q}`, err.Error())))
			return
		}
		wsHub.Broadcast([]byte(fmt.Sprintf(`{"type":"docker_batch_analysis","status":"done","analysis":%q}`, resp)))
	}()
}

func handleDockerTrace(w http.ResponseWriter, r *http.Request, path string) {
	// /docker/trace/:sourceId/:containerId
	parts := strings.Split(strings.TrimPrefix(path, "/docker/trace/"), "/")
	if len(parts) < 2 {
		http.Error(w, "invalid path", 400)
		return
	}
	sourceID := parts[0]
	containerID := parts[1]

	config := getDockerConfig(sourceID)
	trace, err := docker.TraceContainerLinks(sourceID, containerID, config)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	jsonWrite(w, trace)
}

func handleDockerAction(w http.ResponseWriter, r *http.Request, path string) {
	// /docker/:sourceId/:containerId/:action
	parts := strings.Split(strings.TrimPrefix(path, "/docker/"), "/")
	if len(parts) < 3 {
		http.Error(w, "invalid path", 400)
		return
	}
	sourceID := parts[0]
	containerID := parts[1]
	action := parts[2]

	config := getDockerConfig(sourceID)

	var err error
	switch action {
	case "start":
		err = docker.StartContainer(sourceID, containerID, config)
	case "stop":
		err = docker.StopContainer(sourceID, containerID, config)
	case "restart":
		err = docker.RestartContainer(sourceID, containerID, config)
	case "pause":
		err = docker.PauseContainer(sourceID, containerID, config)
	case "unpause":
		err = docker.UnpauseContainer(sourceID, containerID, config)
	case "exec":
		var req struct {
			Command string `json:"command"`
		}
		if err := jsonRead(r, &req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		output, execErr := docker.ExecInContainer(sourceID, containerID, strings.Fields(req.Command), config)
		if execErr != nil {
			http.Error(w, execErr.Error(), 500)
			return
		}
		jsonWrite(w, map[string]string{"output": output})
		return
	default:
		http.Error(w, "unknown action: "+action, 400)
		return
	}

	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	jsonWrite(w, map[string]bool{"ok": true})
}

func getDockerConfig(sourceID string) docker.DockerConfig {
	settings := getSettings()
	sources, _ := settings["dockerSources"].([]interface{})
	for _, s := range sources {
		src, ok := s.(map[string]interface{})
		if !ok {
			continue
		}
		id, _ := src["id"].(string)
		if id == sourceID {
			return dockerConfigFromMap(src)
		}
	}
	return docker.DockerConfig{}
}

// ============ Remote Handlers ============

func handleRemoteList(w http.ResponseWriter, r *http.Request) {
	var servers []remote.Server
	db.GetJSON("remote_servers", &servers)
	if servers == nil {
		servers = []remote.Server{}
	}
	// Mark connection status - derive from live state but preserve error
	for i := range servers {
		servers[i].Connected = remote.Mgr.IsConnected(servers[i].ID)
		if servers[i].Connected {
			servers[i].Status = "connected"
		} else if servers[i].Status != "error" {
			servers[i].Status = "disconnected"
		}
	}
	// Hide sensitive fields from API response
	for i := range servers {
		servers[i].Password = ""
		servers[i].PrivateKey = ""
	}
	jsonWrite(w, map[string]interface{}{"servers": servers})
}

func handleRemoteAdd(w http.ResponseWriter, r *http.Request) {
	var srv remote.Server
	if err := jsonRead(r, &srv); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if srv.ID == "" {
		srv.ID = uuid()
	}

	var servers []remote.Server
	db.GetJSON("remote_servers", &servers)
	servers = append(servers, srv)
	db.SetJSON("remote_servers", servers)
	jsonWrite(w, map[string]bool{"success": true})
}

func handleRemoteTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Host     string `json:"host"`
		Port     int    `json:"port"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	err := remote.TestConnection(req.Host, req.Port, req.Username, req.Password)
	if err != nil {
		jsonWrite(w, map[string]interface{}{"success": false, "error": err.Error()})
		return
	}
	jsonWrite(w, map[string]bool{"success": true})
}

func handleRemoteServer(w http.ResponseWriter, r *http.Request, path string) {
	// /remote/servers/:id/:action or /remote/servers/:id
	parts := strings.Split(strings.TrimPrefix(path, "/remote/servers/"), "/")
	serverID := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	// Get server
	var servers []remote.Server
	db.GetJSON("remote_servers", &servers)
	var srv *remote.Server
	for i := range servers {
		if servers[i].ID == serverID {
			srv = &servers[i]
			break
		}
	}

	if srv == nil && action != "" && action != "connect" {
		http.Error(w, "server not found", 404)
		return
	}

	switch action {
	case "":
		// GET/PUT/DELETE /remote/servers/:id
		switch r.Method {
		case "GET":
			if srv == nil {
				http.Error(w, "server not found", 404)
				return
			}
			srv.Connected = remote.Mgr.IsConnected(serverID)
			jsonWrite(w, srv)
		case "PUT":
			var updated remote.Server
			if err := jsonRead(r, &updated); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			updated.ID = serverID
			for i := range servers {
				if servers[i].ID == serverID {
					// Preserve password/privateKey if not provided (frontend doesn't echo them back)
					if updated.Password == "" {
						updated.Password = servers[i].Password
					}
					if updated.PrivateKey == "" {
						updated.PrivateKey = servers[i].PrivateKey
					}
					if updated.PrivateKeyPath == "" {
						updated.PrivateKeyPath = servers[i].PrivateKeyPath
					}
					servers[i] = updated
					break
				}
			}
			db.SetJSON("remote_servers", servers)
			jsonWrite(w, map[string]bool{"success": true})
		case "DELETE":
			var filtered []remote.Server
			for _, s := range servers {
				if s.ID != serverID {
					filtered = append(filtered, s)
				}
			}
			db.SetJSON("remote_servers", filtered)
			jsonWrite(w, map[string]bool{"success": true})
		}

	case "connect":
		if srv == nil {
			http.Error(w, "server not found", 404)
			return
		}
		if err := remote.Mgr.Connect(srv); err != nil {
			// Update status in database
			var allSrvs []remote.Server
			db.GetJSON("remote_servers", &allSrvs)
			for i := range allSrvs {
				if allSrvs[i].ID == serverID {
					allSrvs[i].Status = "error"
					allSrvs[i].Connected = false
					break
				}
			}
			db.SetJSON("remote_servers", allSrvs)
			wsHub.Broadcast([]byte(fmt.Sprintf(`{"type":"remote_status","serverId":%q,"connected":false}`, serverID)))
			jsonWrite(w, map[string]interface{}{"success": false, "error": err.Error()})
			return
		}
		// Update status in database
		var allSrvs []remote.Server
		db.GetJSON("remote_servers", &allSrvs)
		for i := range allSrvs {
			if allSrvs[i].ID == serverID {
				allSrvs[i].Status = "connected"
				allSrvs[i].Connected = true
				break
			}
		}
		db.SetJSON("remote_servers", allSrvs)
		wsHub.Broadcast([]byte(fmt.Sprintf(`{"type":"remote_status","serverId":%q,"connected":true}`, serverID)))
		jsonWrite(w, map[string]bool{"success": true})

	case "disconnect":
		if srv != nil {
			remote.Mgr.Disconnect(srv)
		}
		// Update status in database
		var allSrvs []remote.Server
		db.GetJSON("remote_servers", &allSrvs)
		for i := range allSrvs {
			if allSrvs[i].ID == serverID {
				allSrvs[i].Status = "disconnected"
				allSrvs[i].Connected = false
				break
			}
		}
		db.SetJSON("remote_servers", allSrvs)
		wsHub.Broadcast([]byte(fmt.Sprintf(`{"type":"remote_status","serverId":%q,"connected":false}`, serverID)))
		jsonWrite(w, map[string]bool{"success": true})

	case "files":
		path := r.URL.Query().Get("path")
		if path == "" {
			path = "/"
		}
		if !srv.Connected {
			jsonWrite(w, map[string]string{"error": "未连接"})
			return
		}
		out, err := srv.ListFiles(path)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		jsonWrite(w, map[string]string{"output": out})

	case "logs":
		file := r.URL.Query().Get("file")
		if file == "" {
			http.Error(w, "file required", 400)
			return
		}
		if !srv.Connected {
			jsonWrite(w, map[string]string{"error": "未连接"})
			return
		}
		lines := 200
		fmt.Sscanf(r.URL.Query().Get("lines"), "%d", &lines)
		out, err := srv.ReadLog(file, lines)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		jsonWrite(w, map[string]string{"content": out})

	case "stats":
		stats := srv.GetStats()
		jsonWrite(w, stats)

	case "exec":
		var req struct {
			Command string `json:"command"`
		}
		if err := jsonRead(r, &req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		out, err := srv.Exec(req.Command)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		jsonWrite(w, map[string]string{"output": out})

	case "shell":
		srv.HandleShell(w, r)

	case "file":
		subAction := ""
		if len(parts) > 2 {
			subAction = parts[2]
		}
		switch subAction {
		case "read":
			path := r.URL.Query().Get("path")
			if path == "" { path = "/"
				http.Error(w, "path required", 400)
				return
			}
			content, err := srv.ReadFile(path, 0, 1<<20)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			jsonWrite(w, map[string]string{"content": content})
		case "write":
			var req struct {
				Path    string `json:"path"`
				Content string `json:"content"`
			}
			if err := jsonRead(r, &req); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			if err := srv.WriteFile(req.Path, req.Content); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			jsonWrite(w, map[string]bool{"success": true})
		case "upload":
			var req struct {
				Path    string `json:"path"`
				Content string `json:"content"`
				Name    string `json:"name"`
			}
			if err := jsonRead(r, &req); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			if err := srv.Upload(req.Path, []byte(req.Content)); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			jsonWrite(w, map[string]bool{"success": true})
		default:
			http.Error(w, "unknown file action: "+subAction, 400)
		}

	default:
		http.Error(w, "unknown action: "+action, 400)
	}
}

// ============ Memory Handlers ============

func handleMemoryList(w http.ResponseWriter, r *http.Request) {
	var mems []map[string]string
	db.GetJSON("assistant_memory", &mems)
	if mems == nil {
		mems = []map[string]string{}
	}
	jsonWrite(w, map[string]interface{}{"files": mems})
}

func handleMemorySave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name    string `json:"name"`
		Content string `json:"content"`
	}
	if err := jsonRead(r, &req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	var mems []map[string]string
	db.GetJSON("assistant_memory", &mems)

	// Update or add
	found := false
	for i, m := range mems {
		if m["name"] == req.Name {
			mems[i] = map[string]string{"name": req.Name, "content": req.Content, "updatedAt": fmt.Sprintf("%d", time.Now().UnixMilli())}
			found = true
			break
		}
	}
	if !found {
		mems = append(mems, map[string]string{"name": req.Name, "content": req.Content, "updatedAt": fmt.Sprintf("%d", time.Now().UnixMilli())})
	}

	db.SetJSON("assistant_memory", mems)
	jsonWrite(w, map[string]bool{"success": true})
}

func handleMemoryDelete(w http.ResponseWriter, r *http.Request, name string) {
	var mems []map[string]string
	db.GetJSON("assistant_memory", &mems)

	var filtered []map[string]string
	for _, m := range mems {
		if m["name"] != name {
			filtered = append(filtered, m)
		}
	}
	db.SetJSON("assistant_memory", filtered)
	jsonWrite(w, map[string]bool{"success": true})
}

// ============ Remote Auto Reconnect ============

func startRemoteReconnect() {
	ticker := time.NewTicker(30 * time.Second)
	go func() {
		for range ticker.C {
			var servers []remote.Server
			db.GetJSON("remote_servers", &servers)
			for _, srv := range servers {
				if srv.Connected && !remote.Mgr.IsConnected(srv.ID) {
					if err := remote.Mgr.Connect(&srv); err == nil {
						wsHub.Broadcast([]byte(fmt.Sprintf(`{"type":"remote_status","serverId":%q,"connected":true}`, srv.ID)))
					}
				}
			}
		}
	}()
}

func mustMarshal(v interface{}) string {
	data, _ := json.Marshal(v)
	return string(data)
}

// ============ Main ============

func main() {
	cfg := config.Load()

	if err := db.Init(cfg); err != nil {
		log.Fatalf("[DB] Init failed: %v", err)
	}

	go wsHub.Run()
	startMonitor()
	startRemoteReconnect()

	// Init services
	services.InitLogService(func(data []byte) { wsHub.Broadcast(data) })
	services.AnalysisMgr.Init(func(data []byte) { wsHub.Broadcast(data) })

	http.HandleFunc("/ws", handleWS)
	http.HandleFunc("/api/", handleAPI)

	addr := fmt.Sprintf(":%d", cfg.Port)
	fmt.Printf("🚀 OpenLog server (Go) running on http://localhost:%d\n", cfg.Port)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal(err)
	}
}
