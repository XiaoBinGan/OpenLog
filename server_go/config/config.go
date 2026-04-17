package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type Config struct {
	Port         int    `json:"port"`
	DataDir      string `json:"dataDir"`
	DBPath       string `json:"dbPath"`
	AIEndpoint   string `json:"aiEndpoint"`
	AIModel      string `json:"aiModel"`
	AIAPIKey     string `json:"aiApiKey"`
}

func DefaultConfig() *Config {
	home, _ := os.UserHomeDir()
	dataDir := filepath.Join(home, ".openlog", "data")
	os.MkdirAll(dataDir, 0755)
	return &Config{
		Port:         3002,
		DataDir:      dataDir,
		DBPath:       filepath.Join(dataDir, "openlog.db"),
		AIEndpoint:   "http://localhost:11434/v1",
		AIModel:     "qwen2.5:7b",
		AIAPIKey:    "",
	}
}

func Load() *Config {
	cfg := DefaultConfig()
	cfgPath := filepath.Join(cfg.DataDir, "config.json")
	if data, err := os.ReadFile(cfgPath); err == nil {
		json.Unmarshal(data, cfg)
	}
	return cfg
}

func (c *Config) Save() error {
	cfgPath := filepath.Join(c.DataDir, "config.json")
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(cfgPath, data, 0644)
}
