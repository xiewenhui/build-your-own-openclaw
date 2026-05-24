package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"
)

// HITLConfirmer is the interceptor interface inserted between "LLM issues a tool call"
// and "tool actually executes". Callers block until the user approves or denies.
type HITLConfirmer interface {
	// Confirm renders action + detail to the user and waits for y/n.
	// If destructive is false and the implementation is configured to auto-approve
	// non-destructive reads, it returns true without prompting.
	Confirm(action, detail string, destructive bool) bool
}

// CLIConfirmer implements HITLConfirmer via stderr output + stdin readline.
type CLIConfirmer struct {
	// autoApproveReads skips the prompt for non-destructive read operations
	// when true (controlled by HITL_AUTO_READS env var).
	autoApproveReads bool
	reader           *bufio.Reader
}

func newCLIConfirmer() *CLIConfirmer {
	autoReads := os.Getenv("HITL_AUTO_READS") != "false"
	return &CLIConfirmer{
		autoApproveReads: autoReads,
		reader:           bufio.NewReader(os.Stdin),
	}
}

func newCLIConfirmerFromConfig(autoApproveReads bool) *CLIConfirmer {
	return &CLIConfirmer{
		autoApproveReads: autoApproveReads,
		reader:           bufio.NewReader(os.Stdin),
	}
}

// confirmTimeout is how long Confirm waits for user input before defaulting to deny.
const confirmTimeout = 30 * time.Second

func (c *CLIConfirmer) Confirm(action, detail string, destructive bool) bool {
	if !destructive && c.autoApproveReads {
		return true
	}

	// Render to stderr so it doesn't interfere with agent stdout output.
	fmt.Fprintf(os.Stderr, "\n[HITL] %s\n", action)
	if detail != "" {
		fmt.Fprintf(os.Stderr, "%s\n", detail)
	}
	fmt.Fprintf(os.Stderr, "Approve? [y/N] (timeout %s, default N) ", confirmTimeout)

	type result struct{ line string }
	ch := make(chan result, 1)
	go func() {
		line, _ := c.reader.ReadString('\n')
		ch <- result{strings.TrimSpace(strings.ToLower(line))}
	}()

	select {
	case r := <-ch:
		return r.line == "y" || r.line == "yes"
	case <-time.After(confirmTimeout):
		fmt.Fprintln(os.Stderr, "\n[HITL] timeout — denied")
		return false
	}
}
