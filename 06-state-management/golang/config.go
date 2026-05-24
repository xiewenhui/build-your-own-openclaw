package main

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Config is the top-level structure for xclaw.yaml.
type Config struct {
	Agent   AgentConfig   `yaml:"agent"`
	Sandbox SandboxConfig `yaml:"sandbox"`
	Tools   ToolsConfig   `yaml:"tools"`
	State   StateConfig   `yaml:"state"`
}

type StateConfig struct {
	DBPath string `yaml:"dbPath"`
}

type AgentConfig struct {
	MaxIterations int `yaml:"maxIterations"`
	Providers     struct {
		Primary  string `yaml:"primary"`
		Fallback string `yaml:"fallback"`
	} `yaml:"providers"`
}

type SandboxConfig struct {
	Mode    string `yaml:"mode"`
	WorkDir string `yaml:"workDir"`
	HITL    struct {
		AutoApproveReads bool `yaml:"autoApproveReads"`
	} `yaml:"hitl"`
}

type ToolsConfig struct {
	File struct {
		Read   FileOpConfig `yaml:"read"`
		Write  FileOpConfig `yaml:"write"`
		Delete struct {
			Enabled bool `yaml:"enabled"`
		} `yaml:"delete"`
	} `yaml:"file"`
}

type FileOpConfig struct {
	AllowedExtensions []string `yaml:"allowedExtensions"`
	MaxBytes          int      `yaml:"maxBytes"`
}

// defaults returns a Config pre-filled with safe values.
// Fields present in xclaw.yaml override these; missing fields keep the default.
func defaults() Config {
	var cfg Config
	cfg.Agent.MaxIterations = 10
	cfg.Agent.Providers.Primary = "claude"
	cfg.Agent.Providers.Fallback = "openai"
	cfg.Sandbox.Mode = "host"
	cfg.Sandbox.WorkDir = "./workspace"
	cfg.Sandbox.HITL.AutoApproveReads = true
	cfg.Tools.File.Read.AllowedExtensions = []string{
		".txt", ".md", ".json", ".js", ".ts", ".py", ".go", ".yaml", ".yml", ".toml",
	}
	cfg.Tools.File.Read.MaxBytes = 64 * 1024
	cfg.Tools.File.Write.AllowedExtensions = []string{
		".txt", ".md", ".json", ".js", ".ts", ".py", ".go", ".yaml", ".yml", ".toml",
	}
	cfg.Tools.File.Write.MaxBytes = 32 * 1024
	cfg.Tools.File.Delete.Enabled = false
	cfg.State.DBPath = "xclaw.db"
	return cfg
}

// loadConfig reads xclaw.yaml and merges it over the built-in defaults.
// If the file does not exist, the defaults are returned as-is (no error).
func loadConfig(path string) (Config, error) {
	cfg := defaults()

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "[config] %s not found, using defaults\n", path)
		return cfg, nil
	}
	if err != nil {
		return cfg, fmt.Errorf("read %s: %w", path, err)
	}

	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("parse %s: %w", path, err)
	}

	fmt.Fprintf(os.Stderr, "[config] loaded %s\n", path)
	return cfg, nil
}

// extSet converts a slice of extensions into a lookup map.
func extSet(exts []string) map[string]bool {
	m := make(map[string]bool, len(exts))
	for _, e := range exts {
		m[e] = true
	}
	return m
}
