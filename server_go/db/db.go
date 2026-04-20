package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	_ "github.com/mattn/go-sqlite3"
	"openlog/config"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ─── 全局变量 ──────────────────────────────────────────────────────────────

var DB *sql.DB
var once sync.Once

// ─── 初始化 & 迁移 ─────────────────────────────────────────────────────────

func Init(cfg *config.Config) error {
	var err error
	once.Do(func() {
		os.MkdirAll(filepath.Dir(cfg.DBPath), 0755)
		DB, err = sql.Open("sqlite3", cfg.DBPath+"?_journal_mode=WAL&_busy_timeout=5000")
		if err != nil {
			return
		}
		DB.SetMaxOpenConns(1)

		// ── kv_store ───────────────────────────────────────────────────────
		_, err = DB.Exec(`
			CREATE TABLE IF NOT EXISTS kv_store (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`)
		if err != nil {
			return
		}

		// ── monitor_history ───────────────────────────────────────────────
		_, err = DB.Exec(`
			CREATE TABLE IF NOT EXISTS monitor_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				timestamp INTEGER NOT NULL,
				source TEXT NOT NULL,
				cpu REAL,
				mem_used INTEGER,
				mem_total INTEGER,
				disk_used INTEGER,
				disk_total INTEGER,
				network_in INTEGER,
				network_out INTEGER,
				error TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_monitor_timestamp ON monitor_history(timestamp);
			CREATE INDEX IF NOT EXISTS idx_monitor_source ON monitor_history(source);
		`)
		if err != nil {
			return
		}

		// ── machines ──────────────────────────────────────────────────────
		_, err = DB.Exec(`
			CREATE TABLE IF NOT EXISTS machines (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL DEFAULT 'local',
				name TEXT NOT NULL,
				host TEXT,
				port INTEGER,
				ssh_user TEXT,
				log_path TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`)
		if err != nil {
			return
		}

		// ── log_records ──────────────────────────────────────────────────
		_, err = DB.Exec(`
			CREATE TABLE IF NOT EXISTS log_records (
				id TEXT PRIMARY KEY,
				machine_id TEXT NOT NULL,
				source_type TEXT NOT NULL,
				source_name TEXT NOT NULL,
				content TEXT NOT NULL,
				severity TEXT NOT NULL DEFAULT 'error',
				timestamp INTEGER,
				parsed TEXT,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_log_records_machine ON log_records(machine_id);
			CREATE INDEX IF NOT EXISTS idx_log_records_timestamp ON log_records(timestamp);
		`)
		if err != nil {
			return
		}

		// ── analysis_records ──────────────────────────────────────────────
		_, err = DB.Exec(`
			CREATE TABLE IF NOT EXISTS analysis_records (
				id TEXT PRIMARY KEY,
				log_record_id TEXT NOT NULL,
				machine_id TEXT NOT NULL,
				diagnosis TEXT NOT NULL,
				suggestion TEXT,
				severity TEXT,
				model TEXT,
				token_used INTEGER,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (log_record_id) REFERENCES log_records(id) ON DELETE CASCADE,
				FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_analysis_records_log ON analysis_records(log_record_id);
		`)
		if err != nil {
			return
		}

		// ── alert_configs ─────────────────────────────────────────────────
		_, err = DB.Exec(`
			CREATE TABLE IF NOT EXISTS alert_configs (
				id TEXT PRIMARY KEY,
				machine_id TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1,
				patterns TEXT NOT NULL DEFAULT '*.log',
				severity_filter TEXT DEFAULT 'error',
				cooldown_minutes INTEGER DEFAULT 5,
				webhook_url TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
			)
		`)
		if err != nil {
			return
		}

		fmt.Println("[DB] SQLite initialized")
	})
	return err
}

// ─── KV Store ───────────────────────────────────────────────────────────────

// Set 保存原始字符串值（upsert）
func Set(key, value string) error {
	_, err := DB.Exec(
		`INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)`,
		key, value, time.Now().Unix(),
	)
	return err
}

// Get 读取原始字符串值
func Get(key string) (string, error) {
	var value string
	err := DB.QueryRow(`SELECT value FROM kv_store WHERE key = ?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return value, err
}

// Delete 删除 key
func Delete(key string) error {
	_, err := DB.Exec(`DELETE FROM kv_store WHERE key = ?`, key)
	return err
}

// List 返回所有 kv 对
func List() ([]map[string]string, error) {
	rows, err := DB.Query(`SELECT key, value FROM kv_store ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []map[string]string
	for rows.Next() {
		var key, value string
		rows.Scan(&key, &value)
		result = append(result, map[string]string{"key": key, "value": value})
	}
	return result, nil
}

// SetJSON 将任意 value 序列化为 JSON 后存储（upsert）
func SetJSON(key string, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return Set(key, string(data))
}

// GetJSON 读取 kv 值并解析到目标结构体
func GetJSON(key string, v interface{}) error {
	data, err := Get(key)
	if err != nil || data == "" {
		return err
	}
	return json.Unmarshal([]byte(data), v)
}

// ─── Machines ──────────────────────────────────────────────────────────────

type Machine struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Name      string `json:"name"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	SSHUser   string `json:"ssh_user"`
	LogPath   string `json:"log_path"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

// UpsertMachine 插入或更新机器
func UpsertMachine(m *Machine) error {
	now := time.Now().Unix()
	if m.CreatedAt == 0 {
		m.CreatedAt = now
	}
	m.UpdatedAt = now
	_, err := DB.Exec(
		`INSERT INTO machines (id, type, name, host, port, ssh_user, log_path, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   type=excluded.type, name=excluded.name, host=excluded.host,
		   port=excluded.port, ssh_user=excluded.ssh_user, log_path=excluded.log_path,
		   updated_at=excluded.updated_at`,
		m.ID, m.Type, m.Name, m.Host, m.Port, m.SSHUser, m.LogPath, m.CreatedAt, m.UpdatedAt,
	)
	return err
}

// GetMachine 按 ID 读取
func GetMachine(id string) (*Machine, error) {
	row := DB.QueryRow(`SELECT id, type, name, host, port, ssh_user, log_path, created_at, updated_at FROM machines WHERE id = ?`, id)
	var m Machine
	err := row.Scan(&m.ID, &m.Type, &m.Name, &m.Host, &m.Port, &m.SSHUser, &m.LogPath, &m.CreatedAt, &m.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// ListMachines 返回所有机器
func ListMachines() ([]Machine, error) {
	rows, err := DB.Query(`SELECT id, type, name, host, port, ssh_user, log_path, created_at, updated_at FROM machines ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []Machine
	for rows.Next() {
		var m Machine
		rows.Scan(&m.ID, &m.Type, &m.Name, &m.Host, &m.Port, &m.SSHUser, &m.LogPath, &m.CreatedAt, &m.UpdatedAt)
		result = append(result, m)
	}
	return result, nil
}

// DeleteMachine 删除机器
func DeleteMachine(id string) error {
	_, err := DB.Exec(`DELETE FROM machines WHERE id = ?`, id)
	return err
}

// ─── Log Records ────────────────────────────────────────────────────────────

type LogRecord struct {
	ID          string `json:"id"`
	MachineID   string `json:"machine_id"`
	SourceType  string `json:"source_type"`
	SourceName  string `json:"source_name"`
	Content     string `json:"content"`
	Severity    string `json:"severity"`
	Timestamp   int64  `json:"timestamp"`
	Parsed      string `json:"parsed,omitempty"`
	CreatedAt   int64  `json:"created_at"`
}

// InsertLogRecord 插入日志记录
func InsertLogRecord(r *LogRecord) error {
	if r.CreatedAt == 0 {
		r.CreatedAt = time.Now().Unix()
	}
	_, err := DB.Exec(
		`INSERT INTO log_records (id, machine_id, source_type, source_name, content, severity, timestamp, parsed, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.MachineID, r.SourceType, r.SourceName, r.Content, r.Severity, r.Timestamp, r.Parsed, r.CreatedAt,
	)
	return err
}

// ListLogRecords 查询日志记录
func ListLogRecords(machineID, severity string, limit, offset int) ([]LogRecord, error) {
	sql := `SELECT id, machine_id, source_type, source_name, content, severity, timestamp, parsed, created_at FROM log_records WHERE 1=1`
	args := []interface{}{}
	if machineID != "" {
		sql += ` AND machine_id = ?`
		args = append(args, machineID)
	}
	if severity != "" {
		sql += ` AND severity = ?`
		args = append(args, severity)
	}
	sql += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`
	args = append(args, limit, offset)
	rows, err := DB.Query(sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []LogRecord
	for rows.Next() {
		var r LogRecord
		rows.Scan(&r.ID, &r.MachineID, &r.SourceType, &r.SourceName, &r.Content, &r.Severity, &r.Timestamp, &r.Parsed, &r.CreatedAt)
		result = append(result, r)
	}
	return result, nil
}

// ─── Analysis Records ───────────────────────────────────────────────────────

type AnalysisRecord struct {
	ID          string `json:"id"`
	LogRecordID string `json:"log_record_id"`
	MachineID   string `json:"machine_id"`
	Diagnosis   string `json:"diagnosis"`
	Suggestion  string `json:"suggestion"`
	Severity    string `json:"severity"`
	Model       string `json:"model"`
	TokenUsed   int    `json:"token_used"`
	CreatedAt   int64  `json:"created_at"`
}

// InsertAnalysis 插入分析记录
func InsertAnalysis(r *AnalysisRecord) error {
	if r.CreatedAt == 0 {
		r.CreatedAt = time.Now().Unix()
	}
	_, err := DB.Exec(
		`INSERT INTO analysis_records (id, log_record_id, machine_id, diagnosis, suggestion, severity, model, token_used, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.LogRecordID, r.MachineID, r.Diagnosis, r.Suggestion, r.Severity, r.Model, r.TokenUsed, r.CreatedAt,
	)
	return err
}

// ListAnalysis 查询分析记录
func ListAnalysis(machineID, logRecordID string, limit int) ([]AnalysisRecord, error) {
	sql := `SELECT id, log_record_id, machine_id, diagnosis, suggestion, severity, model, token_used, created_at FROM analysis_records WHERE 1=1`
	args := []interface{}{}
	if machineID != "" {
		sql += ` AND machine_id = ?`
		args = append(args, machineID)
	}
	if logRecordID != "" {
		sql += ` AND log_record_id = ?`
		args = append(args, logRecordID)
	}
	sql += ` ORDER BY created_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := DB.Query(sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []AnalysisRecord
	for rows.Next() {
		var r AnalysisRecord
		rows.Scan(&r.ID, &r.LogRecordID, &r.MachineID, &r.Diagnosis, &r.Suggestion, &r.Severity, &r.Model, &r.TokenUsed, &r.CreatedAt)
		result = append(result, r)
	}
	return result, nil
}

// ─── Alert Configs ──────────────────────────────────────────────────────────

type AlertConfig struct {
	ID              string `json:"id"`
	MachineID       string `json:"machine_id"`
	Enabled         bool   `json:"enabled"`
	Patterns        string `json:"patterns"`
	SeverityFilter  string `json:"severity_filter"`
	CooldownMinutes int    `json:"cooldown_minutes"`
	WebhookURL      string `json:"webhook_url"`
	CreatedAt       int64  `json:"created_at"`
	UpdatedAt       int64  `json:"updated_at"`
}

// GetAlertConfig 读取告警配置
func GetAlertConfig(machineID string) (*AlertConfig, error) {
	row := DB.QueryRow(
		`SELECT id, machine_id, enabled, patterns, severity_filter, cooldown_minutes, webhook_url, created_at, updated_at FROM alert_configs WHERE machine_id = ?`,
		machineID,
	)
	var c AlertConfig
	var enabled int
	err := row.Scan(&c.ID, &c.MachineID, &enabled, &c.Patterns, &c.SeverityFilter, &c.CooldownMinutes, &c.WebhookURL, &c.CreatedAt, &c.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.Enabled = enabled == 1
	return &c, nil
}

// UpsertAlertConfig 插入或更新告警配置
func UpsertAlertConfig(c *AlertConfig) error {
	now := time.Now().Unix()
	if c.CreatedAt == 0 {
		c.CreatedAt = now
	}
	c.UpdatedAt = now
	enabled := 0
	if c.Enabled {
		enabled = 1
	}
	_, err := DB.Exec(
		`INSERT INTO alert_configs (id, machine_id, enabled, patterns, severity_filter, cooldown_minutes, webhook_url, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   enabled=excluded.enabled, patterns=excluded.patterns,
		   severity_filter=excluded.severity_filter, cooldown_minutes=excluded.cooldown_minutes,
		   webhook_url=excluded.webhook_url, updated_at=excluded.updated_at`,
		c.ID, c.MachineID, enabled, c.Patterns, c.SeverityFilter, c.CooldownMinutes, c.WebhookURL, c.CreatedAt, c.UpdatedAt,
	)
	return err
}

// ─── 关闭 ───────────────────────────────────────────────────────────────────

func Close() error {
	if DB != nil {
		return DB.Close()
	}
	return nil
}
