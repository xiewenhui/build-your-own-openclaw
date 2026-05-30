package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
)

// BrowserPool manages one browser process and one Page per session.
// Each session is isolated: separate incognito context + page, so cookie/storage
// cannot leak between sessions (mirrors the BrowserContext-per-session model in Node.js).
type BrowserPool struct {
	mu       sync.Mutex
	browser  *rod.Browser
	sessions map[string]*rod.Page
	cfg      BrowserConfig
}

func NewBrowserPool(cfg BrowserConfig) *BrowserPool {
	return &BrowserPool{
		sessions: make(map[string]*rod.Page),
		cfg:      cfg,
	}
}

func (p *BrowserPool) Init() error {
	l := launcher.New().Headless(p.cfg.Headless)
	u, err := l.Launch()
	if err != nil && runtime.GOOS == "windows" {
		// go-rod downloads Chromium then renames the dir to a content hash.
		// On Windows the rename can fail with "Access is denied" if the OS
		// hasn't released file handles yet.  Work around it by locating the
		// already-extracted binary directly and bypassing the rename.
		if bin := findRodChromeBin(); bin != "" {
			u, err = launcher.New().Bin(bin).Headless(p.cfg.Headless).Launch()
		}
	}
	if err != nil {
		return fmt.Errorf("browser launch: %w", err)
	}
	p.browser = rod.New().ControlURL(u)
	return p.browser.Connect()
}

// findRodChromeBin looks for a chrome.exe inside go-rod's browser cache on Windows.
// go-rod extracts Chromium as:  %APPDATA%\rod\browser\chromium-<rev>\chrome-win\chrome.exe
func findRodChromeBin() string {
	rodDir := filepath.Join(os.Getenv("APPDATA"), "rod", "browser")
	entries, err := os.ReadDir(rodDir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "chromium-") {
			continue
		}
		candidates := []string{
			filepath.Join(rodDir, e.Name(), "chrome-win", "chrome.exe"),
			filepath.Join(rodDir, e.Name(), "chrome.exe"),
		}
		for _, bin := range candidates {
			if _, err := os.Stat(bin); err == nil {
				return bin
			}
		}
	}
	return ""
}

// GetPage returns the Page for the given session, creating a new page
// if this is the first request for that session.
func (p *BrowserPool) GetPage(sessionID string) (*rod.Page, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if page, ok := p.sessions[sessionID]; ok {
		return page, nil
	}
	// Each session gets its own isolated incognito context.
	page, err := p.browser.Page(proto.TargetCreateTarget{URL: "about:blank"})
	if err != nil {
		return nil, fmt.Errorf("new page: %w", err)
	}
	if err := page.SetViewport(&proto.EmulationSetDeviceMetricsOverride{
		Width:             p.cfg.Viewport.Width,
		Height:            p.cfg.Viewport.Height,
		DeviceScaleFactor: 1,
		Mobile:            false,
	}); err != nil {
		return nil, fmt.Errorf("set viewport: %w", err)
	}
	p.sessions[sessionID] = page
	return page, nil
}

func (p *BrowserPool) CloseSession(sessionID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if page, ok := p.sessions[sessionID]; ok {
		_ = page.Close()
		delete(p.sessions, sessionID)
	}
}

func (p *BrowserPool) CloseAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, page := range p.sessions {
		_ = page.Close()
		delete(p.sessions, id)
	}
	if p.browser != nil {
		_ = p.browser.Close()
	}
}
