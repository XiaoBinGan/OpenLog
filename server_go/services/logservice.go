package services

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"openlog/config"
)

type LogEntry struct {
	Time    string `json:"time"`
	Level   string `json:"level"`
	Message string `json:"message"`
	Raw     string `json:"raw"`
}

type LogSource struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Path    string            `json:"path"`
	Entries []LogEntry        `json:"entries"`
	Offsets map[string]int64 `json:"-"`
	mu      sync.RWMutex
}

type LogService struct {
	sources         map[string]*LogSource
	mu              sync.RWMutex
	analysisQueue   map[string]*logAnalysisJob
	analysisQueueMu sync.RWMutex
	broadcast       func([]byte)
}

type logAnalysisJob struct {
	sourceID  string
	logs      string
	timestamp time.Time
}

var LogServiceInstance *LogService

func InitLogService(broadcast func([]byte)) {
	LogServiceInstance = &LogService{
		sources:       make(map[string]*LogSource),
		analysisQueue: make(map[string]*logAnalysisJob),
		broadcast:     broadcast,
	}
	// Initialize the analysis manager with broadcast
	AnalysisMgr.Init(broadcast)
}

const MaxLogEntries = 10000
const analysisDebounce = 30 * time.Second

func (s *LogService) AddSource(src *LogSource) {
	s.mu.Lock()
	src.Offsets = make(map[string]int64)
	s.sources[src.ID] = src
	s.mu.Unlock()
	go s.watchFile(src)
}

func (s *LogService) watchFile(src *LogSource) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		s.readNewContent(src)
	}
}

func (s *LogService) readNewContent(src *LogSource) {
	file, err := os.Open(src.Path)
	if err != nil {
		return
	}
	defer file.Close()

	info, _ := file.Stat()
	if info == nil {
		return
	}
	currentSize := info.Size()

	src.mu.Lock()
	offset, seenBefore := src.Offsets[src.Path]
	if seenBefore && offset >= currentSize {
		offset = 0
		src.Offsets[src.Path] = 0
	}

	if offset < currentSize {
		file.Seek(offset, 0)
		reader := bufio.NewReader(file)
		var newLines []string
		for {
			line, err := reader.ReadString('\n')
			if err != nil && err != io.EOF {
				break
			}
			line = strings.TrimRight(line, "\r\n")
			if line != "" {
				newLines = append(newLines, line)
			}
			if err == io.EOF {
				break
			}
		}
		newOffset, _ := file.Seek(0, 1)
		src.Offsets[src.Path] = newOffset

		for _, line := range newLines {
			entry := parseLogLine(line)
			src.Entries = append(src.Entries, entry)
			if len(src.Entries) > MaxLogEntries {
				src.Entries = src.Entries[len(src.Entries)-MaxLogEntries:]
			}
			// Auto-analysis trigger for ERROR/FATAL logs
			level := strings.ToUpper(entry.Level)
			if level == "ERROR" || level == "FATAL" || level == "CRITICAL" {
				AnalysisMgr.Enqueue(entry, src)
			}
		}
		src.mu.Unlock()

		if len(newLines) > 0 && s.broadcast != nil {
			data, _ := json.Marshal(map[string]interface{}{
				"type":   "log",
				"source": src.ID,
				"raw":    strings.Join(newLines, "\n"),
			})
			s.broadcast(data)
		}
	} else {
		src.mu.Unlock()
	}
}

func parseLogLine(line string) LogEntry {
	entry := LogEntry{Raw: line}
	parts := strings.SplitN(line, " ", 4)
	if len(parts) >= 4 {
		entry.Time = parts[0]
		entry.Level = extractLevel(parts[1], parts[2])
		entry.Message = parts[3]
	} else if len(parts) == 3 {
		entry.Time = parts[0]
		entry.Level = extractLevel(parts[1], parts[2])
		entry.Message = parts[2]
	} else if len(parts) == 2 {
		entry.Time = parts[0]
		entry.Message = parts[1]
	} else {
		entry.Message = line
	}
	return entry
}

func extractLevel(a, b string) string {
	levels := []string{"DEBUG", "INFO", "WARN", "WARNING", "ERROR", "FATAL", "CRITICAL", "TRACE"}
	for _, s := range []string{a, b} {
		for _, l := range levels {
			if strings.EqualFold(s, l) {
				return l
			}
		}
	}
	return "INFO"
}

func (s *LogService) GetSource(id string) *LogSource {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sources[id]
}

func (s *LogService) GetAllSources() []*LogSource {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]*LogSource, 0, len(s.sources))
	for _, src := range s.sources {
		result = append(result, src)
	}
	return result
}

func (s *LogService) RemoveSource(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sources, id)
}

func (s *LogService) enqueueAnalysis(sourceID, newContent string) {
	s.analysisQueueMu.Lock()
	defer s.analysisQueueMu.Unlock()
	job, exists := s.analysisQueue[sourceID]
	if exists {
		if len(job.logs)+len(newContent) > 100000 {
			job.logs = job.logs[len(job.logs)-50000:] + "\n[截断...]" + newContent
		} else {
			job.logs += "\n" + newContent
		}
		job.timestamp = time.Now()
	} else {
		if strings.Contains(strings.ToUpper(newContent), "ERROR") ||
			strings.Contains(strings.ToUpper(newContent), "FATAL") ||
			strings.Contains(strings.ToUpper(newContent), "CRITICAL") {
			go s.runAIAnalysis(sourceID, newContent)
		} else {
			s.analysisQueue[sourceID] = &logAnalysisJob{
				sourceID:  sourceID,
				logs:      newContent,
				timestamp: time.Now(),
			}
		}
	}
}

func (s *LogService) runAIAnalysis(sourceID, logs string) {
	cfg := config.Load()
	if cfg.AIEndpoint == "" {
		return
	}
	systemPrompt := "你是一位资深运维工程师。请分析以下日志，找出可能的错误原因并给出修复建议。日志：\n" + logs
	payload := map[string]interface{}{
		"model": cfg.AIModel,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": "请分析"},
		},
		"stream": false,
	}
	body, _ := json.Marshal(payload)
	resp, err := http.Post(cfg.AIEndpoint+"/chat/completions", "application/json", strings.NewReader(string(body)))
	if err != nil {
		log.Printf("[AI] 分析失败: %v", err)
		return
	}
	defer resp.Body.Close()
	result, _ := io.ReadAll(resp.Body)
	var analysis struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	json.Unmarshal(result, &analysis)
	if len(analysis.Choices) > 0 {
		data, _ := json.Marshal(map[string]interface{}{
			"type":      "ai_analysis",
			"sourceId":  sourceID,
			"content":   analysis.Choices[0].Message.Content,
			"timestamp": time.Now().Unix(),
		})
		if s.broadcast != nil {
			s.broadcast(data)
		}
	}
}
