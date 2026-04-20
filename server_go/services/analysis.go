package services

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"openlog/config"
)

// AnalysisRecord represents a single AI analysis result
type AnalysisRecord struct {
	ID         string    `json:"id"`
	Timestamp  string    `json:"timestamp"`
	SourceID   string    `json:"sourceId"`
	SourceName string    `json:"sourceName"`
	Log        LogEntry  `json:"log"`
	Analysis   string    `json:"analysis"`
	Status     string    `json:"status"` // "done", "error", "pending"
	Error      string    `json:"error,omitempty"`
	Model      string    `json:"model"`
}

// QueueStatus represents the status of a source's analysis queue
type QueueStatus struct {
	SourceID    string `json:"sourceId"`
	SourceName  string `json:"sourceName"`
	Pending     int    `json:"pending"`
	Processing  bool   `json:"processing"`
	LastAnalyzed string `json:"lastAnalyzed,omitempty"`
}

type analysisQueue struct {
	sourceID    string
	sourceName  string
	jobs        []analysisJob
	processing  bool
	mu          sync.Mutex
	lastTime    time.Time
}

type analysisJob struct {
	log        LogEntry
	sourceName string
}

const (
	maxHistorySize    = 500
	debounceSeconds   = 30
	debounceKeyLen    = 120
)

// AnalysisMgr is the global analysis manager
var AnalysisMgr = NewAnalysisManager()

// AnalysisManager manages per-source analysis queues and history
type AnalysisManager struct {
	queues     map[string]*analysisQueue
	history    []AnalysisRecord
	historyMu  sync.RWMutex
	debounce   map[string]int64
	debounceMu sync.RWMutex
	broadcast  func([]byte)
	quit       chan struct{}
}

// NewAnalysisManager creates a new AnalysisManager
func NewAnalysisManager() *AnalysisManager {
	return &AnalysisManager{
		queues:   make(map[string]*analysisQueue),
		history:  make([]AnalysisRecord, 0),
		debounce: make(map[string]int64),
		quit:     make(chan struct{}),
	}
}

// Init initializes the analysis manager with a broadcast function
func (m *AnalysisManager) Init(broadcast func([]byte)) {
	m.broadcast = broadcast
	// Start queue processor
	go m.processQueues()
}

// Enqueue adds a log entry to the analysis queue if it passes debounce checks
func (m *AnalysisManager) Enqueue(entry LogEntry, source *LogSource) {
	level := strings.ToUpper(entry.Level)
	if level != "ERROR" && level != "FATAL" && level != "CRITICAL" {
		return
	}

	// Debounce check: same error message prefix within debounceSeconds
	key := source.ID + ":" + truncateString(entry.Message, debounceKeyLen)
	now := time.Now().Unix()
	m.debounceMu.RLock()
	lastTs, exists := m.debounce[key]
	m.debounceMu.RUnlock()
	if exists && now-lastTs < int64(debounceSeconds) {
		return
	}
	m.debounceMu.Lock()
	m.debounce[key] = now
	m.debounceMu.Unlock()

	// Get or create queue
	q := m.getOrCreateQueue(source.ID, source.Name)
	q.mu.Lock()
	q.jobs = append(q.jobs, analysisJob{log: entry, sourceName: source.Name})
	q.mu.Unlock()
}

// GetQueueStatus returns the status of all analysis queues
func (m *AnalysisManager) GetQueueStatus() map[string]QueueStatus {
	result := make(map[string]QueueStatus)
	for id, q := range m.queues {
		q.mu.Lock()
		result[id] = QueueStatus{
			SourceID:     q.sourceID,
			SourceName:   q.sourceName,
			Pending:      len(q.jobs),
			Processing:   q.processing,
			LastAnalyzed: q.lastTime.Format(time.RFC3339),
		}
		q.mu.Unlock()
	}
	return result
}

// GetHistory returns analysis history with optional filters
func (m *AnalysisManager) GetHistory(sourceID, status string, limit, offset int) []AnalysisRecord {
	m.historyMu.RLock()
	defer m.historyMu.RUnlock()

	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	var filtered []AnalysisRecord
	for i := len(m.history) - 1; i >= 0; i-- {
		rec := m.history[i]
		if sourceID != "" && rec.SourceID != sourceID {
			continue
		}
		if status != "" && rec.Status != status {
			continue
		}
		filtered = append(filtered, rec)
	}

	if offset >= len(filtered) {
		return []AnalysisRecord{}
	}
	end := offset + limit
	if end > len(filtered) {
		end = len(filtered)
	}
	return filtered[offset:end]
}

// DeleteHistory deletes a single analysis record by ID
func (m *AnalysisManager) DeleteHistory(id string) bool {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()
	for i, rec := range m.history {
		if rec.ID == id {
			m.history = append(m.history[:i], m.history[i+1:]...)
			return true
		}
	}
	return false
}

// ClearHistory clears all analysis history
func (m *AnalysisManager) ClearHistory() {
	m.historyMu.Lock()
	m.history = make([]AnalysisRecord, 0)
	m.historyMu.Unlock()
}

// TriggerManual triggers a manual analysis
func (m *AnalysisManager) TriggerManual(message, sourceID, sourceName string) AnalysisRecord {
	entry := LogEntry{
		Time:    time.Now().Format(time.RFC3339),
		Level:   "ERROR",
		Message: message,
		Raw:     message,
	}
	record := m.createRecord(entry, sourceID, sourceName)
	m.addHistory(record)

	// Run analysis in background
	q := m.getOrCreateQueue(sourceID, sourceName)
	q.mu.Lock()
	q.jobs = append(q.jobs, analysisJob{log: entry, sourceName: sourceName})
	q.mu.Unlock()

	return record
}

func (m *AnalysisManager) getOrCreateQueue(sourceID, sourceName string) *analysisQueue {
	q, exists := m.queues[sourceID]
	if !exists {
		q = &analysisQueue{
			sourceID:   sourceID,
			sourceName: sourceName,
		}
		m.queues[sourceID] = q
	}
	return q
}

func (m *AnalysisManager) createRecord(entry LogEntry, sourceID, sourceName string) AnalysisRecord {
	return AnalysisRecord{
		ID:         fmt.Sprintf("analysis_%d", time.Now().UnixNano()),
		Timestamp:  time.Now().Format(time.RFC3339),
		SourceID:   sourceID,
		SourceName: sourceName,
		Log:        entry,
		Status:     "pending",
		Model:      config.Load().AIModel,
	}
}

func (m *AnalysisManager) addHistory(rec AnalysisRecord) {
	m.historyMu.Lock()
	m.history = append(m.history, rec)
	if len(m.history) > maxHistorySize {
		m.history = m.history[len(m.history)-maxHistorySize:]
	}
	m.historyMu.Unlock()
}

func (m *AnalysisManager) updateHistory(id string, update func(*AnalysisRecord)) {
	m.historyMu.Lock()
	for i := range m.history {
		if m.history[i].ID == id {
			update(&m.history[i])
			break
		}
	}
	m.historyMu.Unlock()
}

func (m *AnalysisManager) processQueues() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			for _, q := range m.queues {
				q.mu.Lock()
				if q.processing || len(q.jobs) == 0 {
					q.mu.Unlock()
					continue
				}
				job := q.jobs[0]
				q.jobs = q.jobs[1:]
				q.processing = true
				q.mu.Unlock()

				go m.runAnalysis(job, q)
			}
		case <-m.quit:
			return
		}
	}
}

func (m *AnalysisManager) runAnalysis(job analysisJob, q *analysisQueue) {
	defer func() {
		q.mu.Lock()
		q.processing = false
		q.lastTime = time.Now()
		q.mu.Unlock()
	}()

	cfg := config.Load()
	if cfg.AIEndpoint == "" {
		return
	}

	record := m.createRecord(job.log, q.sourceID, q.sourceName)
	m.addHistory(record)

	systemPrompt := fmt.Sprintf(`你是一个专业的运维工程师。请分析以下错误日志，找出根因并给出简洁的修复建议。

错误日志：
[%s] [%s] %s
来源: %s

请用以下格式回复（Markdown）：
## 🔍 根因分析
[一句话说明最可能的根因]

## 💡 修复建议
1. [具体可操作的修复步骤]
2. [...]

回复语言与日志一致（中文日志用中文）。`, job.log.Time, job.log.Level, job.log.Message, job.sourceName)

	payload := map[string]interface{}{
		"model": cfg.AIModel,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": "请分析以上错误日志"},
		},
		"stream": false,
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", cfg.AIEndpoint+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		m.updateHistory(record.ID, func(r *AnalysisRecord) {
			r.Status = "error"
			r.Error = err.Error()
		})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if cfg.AIAPIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.AIAPIKey)
	}

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		m.updateHistory(record.ID, func(r *AnalysisRecord) {
			r.Status = "error"
			r.Error = err.Error()
		})
		log.Printf("[Analysis] AI request failed: %v", err)
		return
	}
	defer resp.Body.Close()

	result, _ := io.ReadAll(resp.Body)
	var aiResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(result, &aiResp) != nil || len(aiResp.Choices) == 0 {
		m.updateHistory(record.ID, func(r *AnalysisRecord) {
			r.Status = "error"
			r.Error = "invalid AI response"
		})
		return
	}

	analysis := aiResp.Choices[0].Message.Content
	m.updateHistory(record.ID, func(r *AnalysisRecord) {
		r.Status = "done"
		r.Analysis = analysis
		r.Model = cfg.AIModel
	})

	// Broadcast the analysis result via WebSocket
	if m.broadcast != nil {
		data, _ := json.Marshal(map[string]interface{}{
			"type":      "ai_analysis",
			"sourceId":  q.sourceID,
			"content":   analysis,
			"recordId":  record.ID,
			"timestamp": time.Now().Unix(),
		})
		m.broadcast(data)
	}
}

func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}
