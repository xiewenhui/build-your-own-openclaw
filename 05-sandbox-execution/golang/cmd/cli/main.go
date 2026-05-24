package main

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/gorilla/websocket"
)

func main() {
	port := os.Getenv("WEB_PORT")
	if port == "" {
		port = "3000"
	}
	url := "ws://127.0.0.1:" + port + "/ws"
	sessionID := "cli-" + shortID()

	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		log.Fatalf("[cli] connect error: %v", err)
	}
	defer conn.Close()
	fmt.Fprintf(os.Stderr, "[cli] connected to %s (session: %s)\n", url, sessionID)

	// ready signals that the terminal is free to prompt again
	ready := make(chan struct{}, 1)
	ready <- struct{}{}

	// recv goroutine: print agent output and signal when a turn completes
	go func() {
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				fmt.Fprintln(os.Stderr, "[cli] disconnected")
				os.Exit(0)
			}
			var pkt struct {
				Type    string `json:"type"`
				Content string `json:"content"`
			}
			if json.Unmarshal(msg, &pkt) != nil {
				continue
			}
			switch pkt.Type {
			case "delta":
				fmt.Print(pkt.Content)
			case "reply":
				fmt.Println()
				ready <- struct{}{}
			case "error":
				fmt.Fprintf(os.Stderr, "error: %s\n", pkt.Content)
				ready <- struct{}{}
			}
		}
	}()

	scanner := bufio.NewScanner(os.Stdin)
	for {
		<-ready
		fmt.Print("You: ")
		if !scanner.Scan() {
			break
		}
		text := strings.TrimSpace(scanner.Text())
		if strings.ToLower(text) == "exit" {
			break
		}
		if text == "" {
			ready <- struct{}{}
			continue
		}
		payload, _ := json.Marshal(map[string]string{
			"type":      "message",
			"sessionId": sessionID,
			"content":   text,
		})
		if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
			fmt.Fprintf(os.Stderr, "[cli] send error: %v\n", err)
			break
		}
	}
}

func shortID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%08x", b)
}
