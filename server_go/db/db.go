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

var DB *sql.DB
var once sync.Once

func Init(cfg *config.Config) error {
	var err error
	once.Do(func() {
		os.MkdirAll(filepath.Dir(cfg.DBPath), 0755)
		DB, err = sql.Open("sqlite3", cfg.DBPath+"?_journal_mode=WAL&_busy_timeout=5000")
		if err != nil {
			return
		}
		DB.SetMaxOpenConns(1)
		_, err = DB.Exec(`
			CREATE TABLE IF NOT EXISTS kv_store (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
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
		if err == nil {
			fmt.Println("[DB] SQLite initialized")
		}
	})
	return err
}

func Set(key, value string) error {
	_, err := DB.Exec(
		`INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)`,
		key, value, time.Now().Unix(),
	)
	return err
}

func Get(key string) (string, error) {
	var value string
	err := DB.QueryRow(`SELECT value FROM kv_store WHERE key = ?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return value, err
}

func Delete(key string) error {
	_, err := DB.Exec(`DELETE FROM kv_store WHERE key = ?`, key)
	return err
}

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

func SetJSON(key string, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return Set(key, string(data))
}

func GetJSON(key string, v interface{}) error {
	data, err := Get(key)
	if err != nil || data == "" {
		return err
	}
	return json.Unmarshal([]byte(data), v)
}

func Close() error {
	if DB != nil {
		return DB.Close()
	}
	return nil
}
