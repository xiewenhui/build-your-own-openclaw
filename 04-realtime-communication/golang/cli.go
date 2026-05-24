package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

type cliAdapter struct {
	mu      sync.Mutex
	handler func(ACPMessage)
	replyCh chan struct{}
}

func newCLIAdapter() *cliAdapter { return &cliAdapter{} }

func (c *cliAdapter) name() string { return "cli" }

func (c *cliAdapter) onMessage(h func(ACPMessage)) { c.handler = h }

func (c *cliAdapter) send(reply AgentReply) {
	switch reply.Type {
	case "delta":
		os.Stdout.WriteString(reply.Content)
	case "reply":
		os.Stdout.WriteString("\n")
		c.signal()
	case "error":
		fmt.Fprintf(os.Stderr, "[cli] error: %s\n", reply.Content)
		c.signal()
	}
}

func (c *cliAdapter) signal() {
	c.mu.Lock()
	ch := c.replyCh
	c.mu.Unlock()
	if ch != nil {
		ch <- struct{}{}
	}
}

func (c *cliAdapter) start() error {
	fmt.Fprintln(os.Stderr, "[cli] ready — type your message (exit to quit)")
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for {
			fmt.Print("You: ")
			if !scanner.Scan() {
				break
			}
			text := strings.TrimSpace(scanner.Text())
			if strings.ToLower(text) == "exit" {
				break
			}
			if text == "" {
				continue
			}

			ch := make(chan struct{}, 1)
			c.mu.Lock()
			c.replyCh = ch
			c.mu.Unlock()

			c.handler(ACPMessage{
				ID:        newUUID(),
				SessionID: "cli",
				Channel:   "cli",
				Content:   text,
				Timestamp: time.Now().UnixMilli(),
			})

			<-ch

			c.mu.Lock()
			c.replyCh = nil
			c.mu.Unlock()
		}
		os.Exit(0)
	}()
	return nil
}
