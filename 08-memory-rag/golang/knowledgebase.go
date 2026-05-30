package main

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// chunkText splits text into overlapping fixed-size chunks.
// maxChars is the max characters per chunk; overlapChars is the overlap
// between consecutive chunks to preserve cross-boundary context.
func chunkText(text string, maxChars, overlapChars int) []string {
	var chunks []string
	start := 0
	for start < len(text) {
		end := start + maxChars
		if end > len(text) {
			end = len(text)
		}
		chunk := strings.TrimSpace(text[start:end])
		if len(chunk) > 0 {
			chunks = append(chunks, chunk)
		}
		if end == len(text) {
			break
		}
		start = end - overlapChars
	}
	return chunks
}

// IndexDocument reads a file, splits it into chunks, embeds each chunk, and
// stores them in the MemoryStore as KB entries. Returns the number of chunks.
func IndexDocument(ctx context.Context, filePath, docID string, store MemoryStore) (int, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return 0, fmt.Errorf("read %q: %w", filePath, err)
	}

	// 512 tokens × 4 chars/token ≈ 2048 chars per chunk; 64 token overlap ≈ 256 chars.
	chunks := chunkText(string(data), 2048, 256)
	for i, chunk := range chunks {
		emb, err := Embed(ctx, chunk)
		if err != nil {
			return i, fmt.Errorf("embed chunk %d: %w", i, err)
		}
		if _, err := store.Save(ctx, MemoryEntry{
			SessionID: "global",
			Source:    SourceKB,
			DocID:     docID,
			Content:   chunk,
			Embedding: emb,
			Tags:      []string{docID, fmt.Sprintf("chunk-%d", i)},
		}); err != nil {
			return i, fmt.Errorf("save chunk %d: %w", i, err)
		}
	}
	return len(chunks), nil
}
