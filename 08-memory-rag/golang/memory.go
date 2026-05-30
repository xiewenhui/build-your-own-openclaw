package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"byoo/xclaw/providers"
	milvusclient "github.com/milvus-io/milvus-sdk-go/v2/client"
	"github.com/milvus-io/milvus-sdk-go/v2/entity"
)

// ── Embedding ─────────────────────────────────────────────────────────────────
//
// We call the embeddings endpoint directly instead of using the go-openai SDK
// because go-openai v1.17.9 uses EmbeddingModel as an int enum, which cannot
// represent arbitrary model names (e.g. Qwen3-Embedding-8B, custom deployments).
// A direct HTTP POST works with any OpenAI-compatible endpoint and model name.

// Embed converts text to a float32 vector.
// Reads OPENAI_API_KEY, OPENAI_API_BASE_URL, OPENAI_EMBEDDING_MODEL from env.
func Embed(ctx context.Context, text string) ([]float32, error) {
	baseURL := strings.TrimRight(os.Getenv("OPENAI_API_BASE_URL"), "/")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	model := os.Getenv("OPENAI_EMBEDDING_MODEL")
	if model == "" {
		model = "text-embedding-3-small"
	}

	body, _ := json.Marshal(map[string]any{"model": model, "input": text})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("embed: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embed: http: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		Data []struct {
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("embed: decode: %w", err)
	}
	if result.Error != nil {
		return nil, fmt.Errorf("embed: API error: %s", result.Error.Message)
	}
	if len(result.Data) == 0 {
		return nil, fmt.Errorf("embed: empty response")
	}
	return result.Data[0].Embedding, nil
}

func cosineSimilarity(a, b []float32) float32 {
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return float32(dot / (math.Sqrt(na) * math.Sqrt(nb)))
}

// ── MemoryEntry ───────────────────────────────────────────────────────────────

type MemorySource string

const (
	SourceAgent MemorySource = "agent"
	SourceKB    MemorySource = "kb"
)

type MemoryEntry struct {
	ID        string
	SessionID string
	Source    MemorySource
	DocID     string // non-empty for KB entries
	Content   string
	Embedding []float32
	Tags      []string
	CreatedAt int64
}

// ── SearchFilter ──────────────────────────────────────────────────────────────

type SearchFilter struct {
	Source    MemorySource // "" = no filter
	SessionID string       // "" = no filter
	DocID     string       // "" = no filter
}

// ── MemoryStore interface ─────────────────────────────────────────────────────

type MemoryStore interface {
	Save(ctx context.Context, entry MemoryEntry) (string, error)
	Search(ctx context.Context, queryEmb []float32, topK int, filter SearchFilter) ([]MemoryEntry, error)
	Delete(ctx context.Context, id string) error
	Close() error
}

// ── SQLiteMemoryStore ─────────────────────────────────────────────────────────

type SQLiteMemoryStore struct {
	db *sql.DB
}

func NewSQLiteMemoryStore(sqlDB *sql.DB) (*SQLiteMemoryStore, error) {
	_, err := sqlDB.Exec(`
CREATE TABLE IF NOT EXISTS memories (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'agent',
    doc_id      TEXT DEFAULT '',
    content     TEXT NOT NULL,
    embedding   TEXT NOT NULL,
    tags        TEXT DEFAULT '[]',
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_mem_source  ON memories(source);
`)
	if err != nil {
		return nil, fmt.Errorf("memory migrate: %w", err)
	}
	return &SQLiteMemoryStore{db: sqlDB}, nil
}

func (s *SQLiteMemoryStore) Save(ctx context.Context, entry MemoryEntry) (string, error) {
	id := randomHex(16)
	embJSON, _ := json.Marshal(entry.Embedding)
	tagsJSON, _ := json.Marshal(entry.Tags)
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO memories (id, session_id, source, doc_id, content, embedding, tags, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, entry.SessionID, string(entry.Source), entry.DocID,
		entry.Content, string(embJSON), string(tagsJSON), time.Now().UnixMilli(),
	)
	if err != nil {
		return "", err
	}
	return id, nil
}

func (s *SQLiteMemoryStore) Search(ctx context.Context, queryEmb []float32, topK int, filter SearchFilter) ([]MemoryEntry, error) {
	q := `SELECT id, session_id, source, doc_id, content, embedding, tags, created_at FROM memories`
	var clauses []string
	var args []any
	if filter.Source != "" {
		clauses = append(clauses, "source = ?")
		args = append(args, string(filter.Source))
	}
	if filter.SessionID != "" {
		clauses = append(clauses, "session_id = ?")
		args = append(args, filter.SessionID)
	}
	if filter.DocID != "" {
		clauses = append(clauses, "doc_id = ?")
		args = append(args, filter.DocID)
	}
	if len(clauses) > 0 {
		q += " WHERE " + strings.Join(clauses, " AND ")
	}

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type scored struct {
		entry MemoryEntry
		score float32
	}
	var all []scored
	for rows.Next() {
		var e MemoryEntry
		var embJSON, tagsJSON, src string
		if err := rows.Scan(&e.ID, &e.SessionID, &src, &e.DocID, &e.Content, &embJSON, &tagsJSON, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Source = MemorySource(src)
		_ = json.Unmarshal([]byte(embJSON), &e.Embedding)
		_ = json.Unmarshal([]byte(tagsJSON), &e.Tags)
		score := cosineSimilarity(queryEmb, e.Embedding)
		all = append(all, scored{e, score})
	}

	sort.Slice(all, func(i, j int) bool { return all[i].score > all[j].score })
	if topK > len(all) {
		topK = len(all)
	}
	result := make([]MemoryEntry, topK)
	for i := 0; i < topK; i++ {
		result[i] = all[i].entry
	}
	return result, nil
}

func (s *SQLiteMemoryStore) Delete(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM memories WHERE id = ?", id)
	return err
}

func (s *SQLiteMemoryStore) Close() error { return nil } // shared with DB; closed by main

// ── MilvusMemoryStore ─────────────────────────────────────────────────────────

const milvusCollection = "xclaw_memories"
const milvusDim = 1536 // text-embedding-3-small dimensionality

type MilvusMemoryStore struct {
	client milvusclient.Client
}

func NewMilvusMemoryStore(address string) (*MilvusMemoryStore, error) {
	c, err := milvusclient.NewGrpcClient(context.Background(), address)
	if err != nil {
		return nil, fmt.Errorf("milvus connect %q: %w", address, err)
	}
	s := &MilvusMemoryStore{client: c}
	if err := s.init(context.Background()); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *MilvusMemoryStore) init(ctx context.Context) error {
	exists, err := s.client.HasCollection(ctx, milvusCollection)
	if err != nil {
		return fmt.Errorf("milvus HasCollection: %w", err)
	}
	if !exists {
		schema := &entity.Schema{
			CollectionName: milvusCollection,
			Fields: []*entity.Field{
				{Name: "id",         DataType: entity.FieldTypeVarChar, PrimaryKey: true, AutoID: false, TypeParams: map[string]string{"max_length": "36"}},
				{Name: "session_id", DataType: entity.FieldTypeVarChar, TypeParams: map[string]string{"max_length": "64"}},
				{Name: "source",     DataType: entity.FieldTypeVarChar, TypeParams: map[string]string{"max_length": "8"}},
				{Name: "doc_id",     DataType: entity.FieldTypeVarChar, TypeParams: map[string]string{"max_length": "128"}},
				{Name: "content",    DataType: entity.FieldTypeVarChar, TypeParams: map[string]string{"max_length": "4096"}},
				{Name: "tags",       DataType: entity.FieldTypeVarChar, TypeParams: map[string]string{"max_length": "512"}},
				{Name: "created_at", DataType: entity.FieldTypeInt64},
				{Name: "embedding",  DataType: entity.FieldTypeFloatVector, TypeParams: map[string]string{"dim": fmt.Sprint(milvusDim)}},
			},
		}
		if err := s.client.CreateCollection(ctx, schema, 1); err != nil {
			return fmt.Errorf("milvus CreateCollection: %w", err)
		}
		idx, _ := entity.NewIndexHNSW(entity.COSINE, 16, 200)
		if err := s.client.CreateIndex(ctx, milvusCollection, "embedding", idx, false); err != nil {
			return fmt.Errorf("milvus CreateIndex: %w", err)
		}
	}
	return s.client.LoadCollection(ctx, milvusCollection, false)
}

func (s *MilvusMemoryStore) Save(ctx context.Context, entry MemoryEntry) (string, error) {
	id := randomHex(16)
	tagsJSON, _ := json.Marshal(entry.Tags)
	content := entry.Content
	if len(content) > 4096 {
		content = content[:4096]
	}
	cols := []entity.Column{
		entity.NewColumnVarChar("id",         []string{id}),
		entity.NewColumnVarChar("session_id", []string{entry.SessionID}),
		entity.NewColumnVarChar("source",     []string{string(entry.Source)}),
		entity.NewColumnVarChar("doc_id",     []string{entry.DocID}),
		entity.NewColumnVarChar("content",    []string{content}),
		entity.NewColumnVarChar("tags",       []string{string(tagsJSON)}),
		entity.NewColumnInt64("created_at",   []int64{time.Now().UnixMilli()}),
		entity.NewColumnFloatVector("embedding", milvusDim, [][]float32{entry.Embedding}),
	}
	if _, err := s.client.Insert(ctx, milvusCollection, "", cols...); err != nil {
		return "", fmt.Errorf("milvus Insert: %w", err)
	}
	return id, nil
}

func (s *MilvusMemoryStore) Search(ctx context.Context, queryEmb []float32, topK int, filter SearchFilter) ([]MemoryEntry, error) {
	var exprs []string
	if filter.Source != ""    { exprs = append(exprs, fmt.Sprintf(`source == "%s"`, filter.Source)) }
	if filter.SessionID != "" { exprs = append(exprs, fmt.Sprintf(`session_id == "%s"`, filter.SessionID)) }
	if filter.DocID != ""     { exprs = append(exprs, fmt.Sprintf(`doc_id == "%s"`, filter.DocID)) }
	expr := strings.Join(exprs, " && ")

	sp, _ := entity.NewIndexHNSWSearchParam(64)
	results, err := s.client.Search(
		ctx, milvusCollection, nil, expr, []string{"id", "session_id", "source", "doc_id", "content", "tags", "created_at"},
		[]entity.Vector{entity.FloatVector(queryEmb)}, "embedding", entity.COSINE, topK, sp,
	)
	if err != nil {
		return nil, fmt.Errorf("milvus Search: %w", err)
	}
	var entries []MemoryEntry
	for _, rs := range results {
		for i := 0; i < rs.ResultCount; i++ {
			var e MemoryEntry
			e.ID, _        = rs.Fields.GetColumn("id").GetAsString(i)
			e.SessionID, _ = rs.Fields.GetColumn("session_id").GetAsString(i)
			src, _         := rs.Fields.GetColumn("source").GetAsString(i)
			e.Source       = MemorySource(src)
			e.DocID, _     = rs.Fields.GetColumn("doc_id").GetAsString(i)
			e.Content, _   = rs.Fields.GetColumn("content").GetAsString(i)
			tagsStr, _     := rs.Fields.GetColumn("tags").GetAsString(i)
			_ = json.Unmarshal([]byte(tagsStr), &e.Tags)
			createdAt, _   := rs.Fields.GetColumn("created_at").GetAsInt64(i)
			e.CreatedAt     = createdAt
			entries = append(entries, e)
		}
	}
	return entries, nil
}

func (s *MilvusMemoryStore) Delete(ctx context.Context, id string) error {
	return s.client.DeleteByPks(ctx, milvusCollection, "", entity.NewColumnVarChar("id", []string{id}))
}

func (s *MilvusMemoryStore) Close() error {
	return s.client.Close()
}

// ── Factory ───────────────────────────────────────────────────────────────────

func createMemoryStore(cfg Config, sqlDB *sql.DB) (MemoryStore, error) {
	if cfg.Memory.Backend == "milvus" {
		return NewMilvusMemoryStore(cfg.Memory.Milvus.Address)
	}
	return NewSQLiteMemoryStore(sqlDB)
}

// ── Auto-extraction pipeline ──────────────────────────────────────────────────

func extractAndSaveMemories(
	ctx context.Context,
	messages []providers.Message,
	sessionID string,
	provider providers.Provider,
	store MemoryStore,
) {
	var lines []string
	for _, m := range messages {
		if m.Role == "system" {
			continue
		}
		text := m.Content
		if m.ImageURL != "" {
			text = "[multimodal]"
		}
		lines = append(lines, m.Role+": "+text)
	}
	history := strings.Join(lines, "\n")
	if len(history) < 50 {
		return
	}

	prompt := "从以下对话中提取值得长期记住的事实（用户偏好、项目设定、重要决策）。\n" +
		"每条一行，以 \"- \" 开头，最多 10 条，无关紧要的内容不要提取：\n\n" + history

	raw, err := provider.Chat(ctx, []providers.Message{{Role: "user", Content: prompt}})
	if err != nil {
		fmt.Fprintf(os.Stderr, "[memory] extraction LLM call failed: %v\n", err)
		return
	}

	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "- ") {
			continue
		}
		content := strings.TrimPrefix(line, "- ")
		if len(content) < 10 {
			continue
		}
		emb, err := Embed(ctx, content)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[memory] embed failed: %v\n", err)
			continue
		}
		if _, err := store.Save(ctx, MemoryEntry{
			SessionID: sessionID,
			Source:    SourceAgent,
			Content:   content,
			Embedding: emb,
			Tags:      []string{"auto-extracted"},
		}); err != nil {
			fmt.Fprintf(os.Stderr, "[memory] save failed: %v\n", err)
		}
	}
}
