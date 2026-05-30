package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

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
	workDir := cfg.Sandbox.WorkDir
	fmt.Fprintf(os.Stderr, "[main] sandbox mode: %s\n", mode)

	if mode == "host" {
		if err := os.MkdirAll(workDir, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "fatal: cannot create workspace %q: %v\n", workDir, err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "[main] workspace: %s\n", workDir)
	}

	// ── State management: open (or create) SQLite database ───────────────────
	dbPath := cfg.State.DBPath
	db, err := initDB(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fatal: cannot open state db %q: %v\n", dbPath, err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "[main] state db: %s\n", dbPath)

	// ── Memory store ──────────────────────────────────────────────────────────
	memoryStore, err := createMemoryStore(cfg, db.db)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fatal: cannot init memory store: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "[main] memory backend: %s topK: %d\n", cfg.Memory.Backend, cfg.Memory.TopK)

	hitl := newCLIConfirmerFromConfig(cfg.Sandbox.HITL.AutoApproveReads)

	var pool *SandboxPool
	if mode == "full" {
		pool = NewSandboxPool()
		defer pool.KillAll()
	}

	registerToolsForMode(mode, pool, hitl, workDir)
	registerMemoryTools(memoryStore)
	registerKBTools(memoryStore, workDir)

	// ── Browser automation ────────────────────────────────────────────────────
	browserPool := NewBrowserPool(cfg.Browser)
	if err := browserPool.Init(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: cannot launch browser: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "[main] browser: headless=%v viewport=%dx%d\n",
		cfg.Browser.Headless, cfg.Browser.Viewport.Width, cfg.Browser.Viewport.Height)
	registerBrowserTools(browserPool, hitl, cfg.Browser)

	chain := buildProviderChainFromConfig(cfg.Agent.Providers.Primary, cfg.Agent.Providers.Fallback)
	agent := newAgentWithMemory(chain, cfg.Agent.MaxIterations, db, memoryStore, cfg.Memory.TopK)
	gw := newGateway(agent, db)
	gw.register(newWebAdapter())
	gw.register(newQQAdapter())
	fmt.Fprintf(os.Stderr, "[gateway] CLI: go run ./cmd/cli\n")

	// ── Graceful shutdown ─────────────────────────────────────────────────────
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		browserPool.CloseAll()
		if pool != nil {
			pool.KillAll()
		}
		_ = memoryStore.Close()
		db.Close()
		os.Exit(0)
	}()

	if err := gw.start(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}

	select {} // block forever; adapters run in goroutines
}
