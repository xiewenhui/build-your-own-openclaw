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

	providers.Register(providers.NewOpenAIProvider())
	providers.Register(providers.NewClaudeProvider())

	chain := buildProviderChain()
	agent := newAgent(chain)
	gw := newGateway(agent)
	gw.register(newCLIAdapter())
	gw.register(newWebAdapter())
	gw.register(newQQAdapter())

	if err := gw.start(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}

	select {} // block forever; adapters run in goroutines
}
