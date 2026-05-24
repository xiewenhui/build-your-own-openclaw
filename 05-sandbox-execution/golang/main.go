package main

import (
	"context"
	"fmt"
	"os"

	"byoo/xclaw/providers"
	"github.com/joho/godotenv"
)

// assemble adapts AssembleContext to the signature StreamWithFallback expects.
func assemble(messages []providers.Message, p providers.Provider) ([]providers.Message, error) {
	return AssembleContext(context.Background(), messages, p)
}

func main() {
	if err := godotenv.Load(); err != nil {
		fmt.Fprintln(os.Stderr, "[main] no .env file, using environment variables")
	}

	cfg, err := loadConfig("xclaw.yaml")
	if err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}

	initToolLimits(cfg.Tools)

	providers.Register(providers.NewOpenAIProvider())
	providers.Register(providers.NewClaudeProvider())

	mode := cfg.Sandbox.Mode
	fmt.Fprintf(os.Stderr, "[main] sandbox mode: %s\n", mode)

	if mode == "host" {
		workDir := cfg.Sandbox.WorkDir
		if err := os.MkdirAll(workDir, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "fatal: cannot create workspace %q: %v\n", workDir, err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "[main] workspace: %s\n", workDir)
	}

	hitl := newCLIConfirmerFromConfig(cfg.Sandbox.HITL.AutoApproveReads)

	var pool *SandboxPool
	if mode == "full" {
		pool = NewSandboxPool()
		defer pool.KillAll()
	}

	registerToolsForMode(mode, pool, hitl)

	chain := buildProviderChainFromConfig(cfg.Agent.Providers.Primary, cfg.Agent.Providers.Fallback)
	agent := newAgent(chain, cfg.Agent.MaxIterations)
	gw := newGateway(agent)
	gw.register(newWebAdapter())
	gw.register(newQQAdapter())
	fmt.Fprintf(os.Stderr, "[gateway] CLI: go run ./cmd/cli\n")

	if err := gw.start(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}

	select {} // block forever; adapters run in goroutines
}
