// OpenForge native daemon: HTTP bridge between the PWA/Android WebView and
// per-project `opencode serve` instances. Also serves the web UI and a
// standalone (engine-less) session store so the UI remains usable when the
// OpenCode binary is not installed on the device.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Port         int
	Host         string
	WorkspaceDir string
	DataDir      string
	WebDir       string
	Token        string
}

var (
	cfg     Config
	lock    sync.Mutex
	instMgr *Manager
)

func main() {
	home, _ := os.UserHomeDir()
	defaultWs := os.Getenv("OCMB_WORKSPACE")
	if defaultWs == "" {
		defaultWs = filepath.Join(home, "opencode-projects")
		if _, err := os.Stat("/sdcard/OpenForge/projects"); err == nil {
			defaultWs = "/sdcard/OpenForge/projects"
		}
	}

	flag.IntVar(&cfg.Port, "port", 8787, "Port to listen on")
	flag.StringVar(&cfg.Host, "host", "127.0.0.1", "Host to bind to")
	flag.StringVar(&cfg.WorkspaceDir, "workspace", defaultWs, "Default workspace directory")
	flag.StringVar(&cfg.DataDir, "data", filepath.Join(home, ".local/share/opencode-mobile"), "Data directory")
	flag.StringVar(&cfg.WebDir, "web", "", "Web static directory")
	flag.StringVar(&cfg.Token, "token", os.Getenv("OCMB_TOKEN"), "Require bearer token for API access (empty disables auth)")
	flag.Parse()

	os.MkdirAll(cfg.WorkspaceDir, 0755)
	os.MkdirAll(cfg.DataDir, 0755)

	instMgr = NewManager()
	go instMgr.reapLoop()

	mux := http.NewServeMux()

	// Health Check
	mux.HandleFunc("/api/health", handleHealth)
	mux.HandleFunc("/health", handleHealth)

	// Projects & Clone
	mux.HandleFunc("/projects", handleProjects)
	mux.HandleFunc("/api/projects", handleProjects)
	mux.HandleFunc("/projects/import", handleProjectImport)
	mux.HandleFunc("/api/projects/import", handleProjectImport)
	mux.HandleFunc("/projects/clone", handleProjectClone)
	mux.HandleFunc("/api/projects/clone", handleProjectClone)
	mux.HandleFunc("/projects/", handleProjectOps)
	mux.HandleFunc("/api/projects/", handleProjectOps)

	// File System & Browse
	mux.HandleFunc("/fs/", handleFS)
	mux.HandleFunc("/api/fs/", handleFS)
	mux.HandleFunc("/api/browse", handleBrowse)
	mux.HandleFunc("/browse", handleBrowse)

	// Terminal
	mux.HandleFunc("/api/terminal/", handleTerminal)
	mux.HandleFunc("/terminal/", handleTerminal)

	// Git & Identity
	mux.HandleFunc("/api/git/config", handleGitGlobalConfig)
	mux.HandleFunc("/git/config", handleGitGlobalConfig)
	mux.HandleFunc("/git/", handleGit)
	mux.HandleFunc("/api/git/", handleGit)

	// Models & LAN Scanner
	mux.HandleFunc("/api/models/scan-lan", handleScanLAN)
	mux.HandleFunc("/api/models/probe-host", handleProbeHost)
	mux.HandleFunc("/api/models/register-local", handleRegisterLocal)
	mux.HandleFunc("/api/models/", handleModels)
	mux.HandleFunc("/api/favorites", handleFavorites)

	// Auth & Settings
	mux.HandleFunc("/api/auth/status", handleAuthStatus)
	mux.HandleFunc("/api/auth/token", handleAuthToken)
	mux.HandleFunc("/api/settings/workspace", handleSettingsWorkspace)

	// OpenCode Proxy / Native Session Handler
	mux.HandleFunc("/oc/", handleOpenCode)
	mux.HandleFunc("/api/oc/", handleOpenCode)

	// Static Web UI
	webPath := cfg.WebDir
	if webPath == "" {
		for _, p := range []string{"pwa", "../pwa", "/android-files/opencode-mobile/pwa"} {
			if _, err := os.Stat(p); err == nil {
				webPath = p
				break
			}
		}
	}

	if webPath != "" {
		fs := http.FileServer(http.Dir(webPath))
		mux.HandleFunc("/ui/", func(w http.ResponseWriter, r *http.Request) {
			r.URL.Path = strings.TrimPrefix(r.URL.Path, "/ui")
			if r.URL.Path == "" || r.URL.Path == "/" {
				http.ServeFile(w, r, filepath.Join(webPath, "index.html"))
				return
			}
			fs.ServeHTTP(w, r)
		})
		mux.HandleFunc("/ui", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/ui/", http.StatusMovedPermanently)
		})
		mux.Handle("/", fs)
	}

	handler := corsMiddleware(authMiddleware(mux))
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	log.Printf("🚀 OpenForge Native Daemon listening on http://%s (workspace: %s, auth: %s)", addr, cfg.WorkspaceDir, map[bool]string{true: "token", false: "off"}[cfg.Token != ""])
	log.Fatal(http.ListenAndServe(addr, handler))
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

var apiPrefixes = []string{"/api/", "/git/", "/fs/", "/oc/", "/projects/", "/terminal/"}

func isAPIPath(p string) bool {
	openPaths := map[string]bool{"/api/health": true, "/health": true}
	if openPaths[p] {
		return false
	}
	for _, pref := range apiPrefixes {
		if strings.HasPrefix(p, pref) {
			return true
		}
	}
	return p == "/projects" || p == "/browse" || p == "/api/browse" || p == "/api/projects" ||
		p == "/projects/import" || p == "/projects/clone" || p == "/api/projects/import" || p == "/api/projects/clone" ||
		p == "/git/config" || p == "/api/git/config" ||
		p == "/api/favorites" || p == "/api/auth/status" || p == "/api/auth/token" ||
		p == "/api/settings/workspace" || p == "/api/models/scan-lan" || p == "/api/models/probe-host" || p == "/api/models/register-local" ||
		strings.HasPrefix(p, "/api/models/")
}

func bearerFromRequest(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	}
	return r.URL.Query().Get("token")
}

func checkToken(provided string) bool {
	if subtle.ConstantTimeCompare([]byte(provided), []byte(cfg.Token)) == 1 {
		return true
	}
	// Constant-time over padded buffers of equal length to avoid length leaks.
	a := make([]byte, 64)
	b := make([]byte, 64)
	copy(a, provided)
	copy(b, cfg.Token)
	return subtle.ConstantTimeCompare(a, b) == 1 && len(provided) == len(cfg.Token)
}

func authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cfg.Token != "" && isAPIPath(r.URL.Path) {
			if !checkToken(bearerFromRequest(r)) {
				writeErr(w, http.StatusUnauthorized, "unauthorized")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// -------------------------------------------------------------- helpers ---

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// writeErr emits a FastAPI-compatible error body ({detail}) that the PWA understands.
func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]interface{}{"ok": false, "detail": msg, "error": msg})
}

func writeOut(w http.ResponseWriter, out string, err error) {
	if err != nil {
		writeErr(w, http.StatusBadRequest, strings.TrimSpace(out+" "+errString(err)))
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "out": out})
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

type blob map[string]interface{}

func decodeBody(r *http.Request, v interface{}) {
	b, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil || len(b) == 0 {
		return
	}
	json.Unmarshal(b, v)
}

// safeJoin resolves rel under root and rejects escapes and symlink traversal.
func safeJoin(root, rel string) (string, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	full := filepath.Clean(filepath.Join(absRoot, rel))
	realRoot, err := filepath.EvalSymlinks(absRoot)
	if err != nil {
		realRoot = absRoot
	}
	realFull, err := filepath.EvalSymlinks(full)
	if err != nil {
		// Target may not exist yet (write); evaluate the deepest existing parent.
		dir := filepath.Dir(full)
		if rd, derr := filepath.EvalSymlinks(dir); derr == nil {
			realFull = filepath.Join(rd, filepath.Base(full))
		} else {
			realFull = full
		}
	}
	for _, r := range []string{realRoot, absRoot} {
		rel2, rerr := filepath.Rel(r, realFull)
		if rerr == nil && rel2 != ".." && !strings.HasPrefix(rel2, ".."+string(filepath.Separator)) {
			return full, nil
		}
	}
	return "", fmt.Errorf("path escapes project root")
}

// safeRef guards git rev / branch arguments against option injection.
var refRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/\-]*$`)

func safeRef(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" || strings.HasPrefix(s, "-") || !refRe.MatchString(s) {
		return "", fmt.Errorf("invalid reference name: %q", s)
	}
	return s, nil
}

func writeFileSecret(path string, data []byte) error {
	if err := os.WriteFile(path, data, 0600); err != nil {
		return err
	}
	os.Chmod(path, 0600)
	return nil
}

func randomToken() string {
	b := make([]byte, 24)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// ------------------------------------------------------------- Instances ---

type Instance struct {
	PID      string
	Path     string
	Port     int
	Cmd      *exec.Cmd
	LastUsed time.Time
}

type Manager struct {
	mu        sync.Mutex
	instances map[string]*Instance
	nextPort  int
}

func NewManager() *Manager {
	return &Manager{
		instances: make(map[string]*Instance),
		nextPort:  4100,
	}
}

func findOpenCodeBinary() string {
	candidates := []string{
		"/usr/local/bin/opencode",
		"/data/data/com.termux/files/usr/bin/opencode",
		"/data/data/com.openforge/files/bin/opencode",
	}
	home, _ := os.UserHomeDir()
	candidates = append(candidates, filepath.Join(home, ".local/bin/opencode"))

	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	if p, err := exec.LookPath("opencode"); err == nil {
		return p
	}
	return ""
}

var ErrNoEngine = fmt.Errorf("opencode engine not found")

func (m *Manager) Get(pid string) (*Instance, error) {
	m.mu.Lock()

	if inst, ok := m.instances[pid]; ok {
		if inst.Cmd != nil && inst.Cmd.Process != nil && isPortHealthy(inst.Port) {
			inst.LastUsed = time.Now()
			m.mu.Unlock()
			return inst, nil
		}
	}

	opencodeBin := findOpenCodeBinary()
	if opencodeBin == "" {
		m.mu.Unlock()
		return nil, ErrNoEngine
	}

	proj := findProject(pid)
	if proj == nil {
		m.mu.Unlock()
		return nil, fmt.Errorf("project '%s' not found", pid)
	}

	port := m.nextPort
	m.nextPort++

	cmd := exec.Command(opencodeBin, "serve", "--port", strconv.Itoa(port), "--hostname", "127.0.0.1")
	cmd.Dir = proj.Path
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		m.mu.Unlock()
		return nil, fmt.Errorf("failed to start opencode for '%s': %w", pid, err)
	}

	inst := &Instance{
		PID:      pid,
		Path:     proj.Path,
		Port:     port,
		Cmd:      cmd,
		LastUsed: time.Now(),
	}
	m.instances[pid] = inst
	go func() { cmd.Wait() }()
	m.mu.Unlock()

	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		if isPortHealthy(port) {
			return inst, nil
		}
		time.Sleep(200 * time.Millisecond)
	}

	// Engine never became healthy; drop it so the next attempt retries cleanly.
	m.mu.Lock()
	delete(m.instances, pid)
	m.mu.Unlock()
	cmd.Process.Kill()
	return inst, nil
}

func (m *Manager) Stop(pid string) bool {
	m.mu.Lock()
	inst := m.instances[pid]
	delete(m.instances, pid)
	m.mu.Unlock()
	if inst != nil && inst.Cmd != nil && inst.Cmd.Process != nil {
		inst.Cmd.Process.Kill()
		return true
	}
	return false
}

func (m *Manager) reapLoop() {
	for range time.Tick(5 * time.Minute) {
		m.mu.Lock()
		var stale []*Instance
		for pid, inst := range m.instances {
			if time.Since(inst.LastUsed) > 30*time.Minute {
				stale = append(stale, inst)
				delete(m.instances, pid)
			}
		}
		m.mu.Unlock()
		for _, inst := range stale {
			if inst.Cmd != nil && inst.Cmd.Process != nil {
				inst.Cmd.Process.Kill()
			}
		}
	}
}

func isPortHealthy(port int) bool {
	client := &http.Client{Timeout: 300 * time.Millisecond}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/global/health", port))
	if err == nil && resp.StatusCode == 200 {
		resp.Body.Close()
		return true
	}
	return false
}

// ---------------------------------------------------------------- Health ---

func handleHealth(w http.ResponseWriter, r *http.Request) {
	engineFound := findOpenCodeBinary() != ""
	sharedHealthy := isPortHealthy(4096) // shared instance used by the Termux flow
	version := ""
	if engineFound {
		out, err := exec.Command(findOpenCodeBinary(), "--version").Output()
		if err == nil {
			version = strings.TrimSpace(string(out))
		}
	}
	writeJSON(w, http.StatusOK, blob{
		"bridge": "ok",
		"auth":   cfg.Token != "",
		"opencode": blob{
			"healthy": engineFound || sharedHealthy,
			"local":   engineFound,
			"shared":  sharedHealthy,
			"version": version,
		},
	})
}

// -------------------------------------------------------------- Projects ---

type Project struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Created bool   `json:"created,omitempty"`
}

type Registry struct {
	Projects []Project `json:"projects"`
}

func getRegistryPath() string {
	return filepath.Join(cfg.DataDir, "projects.json")
}

func readRegistry() Registry {
	var reg Registry
	b, err := os.ReadFile(getRegistryPath())
	if err == nil {
		json.Unmarshal(b, &reg)
	}
	if reg.Projects == nil {
		reg.Projects = []Project{}
	}
	return reg
}

func writeRegistry(reg Registry) {
	b, _ := json.MarshalIndent(reg, "", "  ")
	os.WriteFile(getRegistryPath(), b, 0644)
}

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	reg := regexp.MustCompile("[^a-z0-9]+")
	s = reg.ReplaceAllString(s, "-")
	return strings.Trim(s, "-")
}

func uniqueSlug(reg Registry, slug string) string {
	taken := map[string]bool{}
	for _, p := range reg.Projects {
		taken[p.ID] = true
	}
	pid, i := slug, 2
	for taken[pid] {
		pid = fmt.Sprintf("%s-%d", slug, i)
		i++
	}
	return pid
}

func handleProjects(w http.ResponseWriter, r *http.Request) {
	lock.Lock()
	defer lock.Unlock()

	reg := readRegistry()

	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, blob{"projects": reg.Projects, "workspace": getWorkspaceDir()})
		return
	}

	if r.Method == http.MethodPost {
		var req struct {
			Name          string `json:"name"`
			InitialBr     string `json:"initial_branch"`
			Branch        string `json:"branch"`
			GitInit       *bool  `json:"git_init"`
			InitialBranch string `json:"initialBranch"`
		}
		decodeBody(r, &req)
		slug := slugify(req.Name)
		if slug == "" {
			slug = fmt.Sprintf("project-%d", time.Now().Unix())
		}
		branch := req.InitialBr
		if branch == "" {
			branch = req.InitialBranch
		}
		if branch == "" {
			branch = req.Branch
		}
		if branch == "" {
			branch = "main"
		}

		pid := uniqueSlug(reg, slug)
		projPath := filepath.Join(getWorkspaceDir(), pid)
		os.MkdirAll(projPath, 0755)

		gitInit := req.GitInit == nil || *req.GitInit
		if gitInit {
			exec.Command("git", "init", "--initial-branch", branch, projPath).Run()
			cmd := exec.Command("git", "commit", "--allow-empty", "-m", "initial commit")
			cmd.Dir = projPath
			cmd.Run()
		}

		proj := Project{ID: pid, Name: req.Name, Path: projPath, Created: gitInit}
		reg.Projects = append(reg.Projects, proj)
		writeRegistry(reg)

		writeJSON(w, http.StatusOK, proj)
		return
	}
	writeErr(w, http.StatusMethodNotAllowed, "Method not allowed")
}

func handleProjectImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	decodeBody(r, &req)
	absPath, err := filepath.Abs(req.Path)
	if err != nil || req.Path == "" {
		writeErr(w, http.StatusBadRequest, "Invalid path")
		return
	}
	if fi, serr := os.Stat(absPath); serr != nil || !fi.IsDir() {
		writeErr(w, http.StatusBadRequest, "not a folder: "+absPath)
		return
	}

	lock.Lock()
	defer lock.Unlock()

	reg := readRegistry()
	name := filepath.Base(absPath)
	pid := uniqueSlug(reg, slugify(name))
	proj := Project{ID: pid, Name: name, Path: absPath}
	reg.Projects = append(reg.Projects, proj)
	writeRegistry(reg)

	writeJSON(w, http.StatusOK, proj)
}

func handleProjectClone(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	var req struct {
		URL    string `json:"url"`
		Name   string `json:"name"`
		Branch string `json:"branch"`
	}
	decodeBody(r, &req)
	gitURL := strings.TrimSpace(req.URL)
	if gitURL == "" {
		writeErr(w, http.StatusBadRequest, "Repository URL required")
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		base := filepath.Base(gitURL)
		name = strings.TrimSuffix(base, ".git")
	}

	lock.Lock()
	defer lock.Unlock()

	reg := readRegistry()
	pid := uniqueSlug(reg, slugify(name))
	destPath := filepath.Join(getWorkspaceDir(), pid)
	os.MkdirAll(filepath.Dir(destPath), 0755)

	args := []string{"clone"}
	if req.Branch != "" {
		args = append(args, "--branch", strings.TrimSpace(req.Branch))
	}
	args = append(args, gitURL, destPath)

	cmd := exec.Command("git", args...)
	var errOut bytes.Buffer
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		os.RemoveAll(destPath)
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("Git clone failed: %s %v", strings.TrimSpace(errOut.String()), err))
		return
	}

	proj := Project{ID: pid, Name: name, Path: destPath, Created: true}
	reg.Projects = append(reg.Projects, proj)
	writeRegistry(reg)

	writeJSON(w, http.StatusOK, proj)
}

func handleProjectOps(w http.ResponseWriter, r *http.Request) {
	pid := strings.TrimPrefix(r.URL.Path, "/api/projects/")
	pid = strings.TrimPrefix(pid, "/projects/")
	pid = strings.TrimSuffix(pid, "/stop")
	if pid == "" {
		writeErr(w, http.StatusBadRequest, "Project ID required")
		return
	}

	isStop := strings.HasSuffix(r.URL.Path, "/stop")

	lock.Lock()
	defer lock.Unlock()

	reg := readRegistry()
	switch {
	case r.Method == http.MethodGet:
		for _, p := range reg.Projects {
			if p.ID == pid {
				writeJSON(w, http.StatusOK, p)
				return
			}
		}
		writeErr(w, http.StatusNotFound, "project not found")

	case isStop && r.Method == http.MethodPost:
		ok := instMgr.Stop(pid)
		writeJSON(w, http.StatusOK, blob{"ok": ok})

	case r.Method == http.MethodDelete:
		q := r.URL.Query().Get("delete_dir") == "true"
		found := false
		var updated []Project
		var dirPath string
		for _, p := range reg.Projects {
			if p.ID == pid {
				found = true
				dirPath = p.Path
				continue
			}
			updated = append(updated, p)
		}
		if !found {
			writeErr(w, http.StatusNotFound, "project not found")
			return
		}
		reg.Projects = updated
		writeRegistry(reg)
		instMgr.Stop(pid)
		if q && strings.HasPrefix(filepath.Clean(dirPath), filepath.Clean(getWorkspaceDir())+string(filepath.Separator)) {
			os.RemoveAll(dirPath)
		}
		writeJSON(w, http.StatusOK, blob{"ok": true})

	default:
		writeErr(w, http.StatusMethodNotAllowed, "Method not allowed")
	}
}

// ------------------------------------------------------------ Filesystem ---

func findProject(pid string) *Project {
	reg := readRegistry()
	for _, p := range reg.Projects {
		if p.ID == pid {
			pp := p
			return &pp
		}
	}
	return nil
}

func projectOr404(w http.ResponseWriter, pid string) *Project {
	proj := findProject(pid)
	if proj == nil {
		writeErr(w, http.StatusNotFound, "project not found")
		return nil
	}
	return proj
}

func handleFS(w http.ResponseWriter, r *http.Request) {
	cleanPath := strings.TrimPrefix(r.URL.Path, "/api/fs/")
	cleanPath = strings.TrimPrefix(cleanPath, "/fs/")
	parts := strings.Split(cleanPath, "/")
	if len(parts) < 2 {
		writeErr(w, http.StatusBadRequest, "Invalid path")
		return
	}
	pid := parts[0]
	op := parts[1]

	proj := projectOr404(w, pid)
	if proj == nil {
		return
	}

	switch op {
	case "tree":
		sub := r.URL.Query().Get("path")
		dirPath, jerr := safeJoin(proj.Path, sub)
		if jerr != nil {
			writeErr(w, http.StatusBadRequest, jerr.Error())
			return
		}
		entries, err := os.ReadDir(dirPath)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		type Entry struct {
			Name string `json:"name"`
			Dir  bool   `json:"dir"`
			Size int64  `json:"size"`
		}
		list := []Entry{}
		for _, e := range entries {
			if e.Name() == ".git" || e.Name() == "node_modules" || e.Name() == "__pycache__" {
				continue
			}
			info, _ := e.Info()
			sz := int64(0)
			if info != nil {
				sz = info.Size()
			}
			list = append(list, Entry{Name: e.Name(), Dir: e.IsDir(), Size: sz})
			if len(list) >= 500 {
				break
			}
		}
		writeJSON(w, http.StatusOK, blob{"entries": list, "path": sub})

	case "read":
		rel := r.URL.Query().Get("path")
		filePath, jerr := safeJoin(proj.Path, rel)
		if jerr != nil {
			writeErr(w, http.StatusBadRequest, jerr.Error())
			return
		}
		f, ferr := os.Open(filePath)
		if ferr != nil {
			writeErr(w, http.StatusNotFound, "file not found")
			return
		}
		defer f.Close()
		content, _ := io.ReadAll(io.LimitReader(f, 2<<20)) // 2 MB cap
		writeJSON(w, http.StatusOK, blob{"content": string(content), "path": rel})

	case "write":
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "Method not allowed")
			return
		}
		var req struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		decodeBody(r, &req)
		if len(req.Content) > 8<<20 {
			writeErr(w, http.StatusRequestEntityTooLarge, "file too large (8 MB cap)")
			return
		}
		filePath, jerr := safeJoin(proj.Path, req.Path)
		if jerr != nil {
			writeErr(w, http.StatusBadRequest, jerr.Error())
			return
		}
		os.MkdirAll(filepath.Dir(filePath), 0755)
		if werr := os.WriteFile(filePath, []byte(req.Content), 0644); werr != nil {
			writeErr(w, http.StatusInternalServerError, werr.Error())
			return
		}
		writeJSON(w, http.StatusOK, blob{"ok": true})
	default:
		writeErr(w, http.StatusNotFound, "unknown fs action")
	}
}

func handleBrowse(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		home, _ := os.UserHomeDir()
		p = home
		if _, err := os.Stat("/sdcard"); err == nil {
			p = "/sdcard"
		}
	}
	p, _ = filepath.Abs(p)
	entries, err := os.ReadDir(p)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	type DirItem struct {
		Name  string `json:"name"`
		Path  string `json:"path"`
		IsDir bool   `json:"is_dir"`
	}
	res := []DirItem{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") && e.Name() != ".gitignore" {
			continue
		}
		res = append(res, DirItem{Name: e.Name(), Path: filepath.Join(p, e.Name()), IsDir: e.IsDir()})
		if len(res) >= 500 {
			break
		}
	}
	parent := filepath.Dir(p)
	if parent == p {
		parent = ""
	}
	writeJSON(w, http.StatusOK, blob{"current": p, "path": p, "parent": parent, "entries": res})
}

// ------------------------------------------------------------------- Git ---

func runGit(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return strings.TrimSpace(out.String()), err
}

func runGitOK(dir string, args ...string) (string, error) {
	out, err := runGit(dir, args...)
	if err != nil && out == "" {
		return out, fmt.Errorf("git %s failed", args[0])
	}
	return out, err
}

func isGitRepo(dir string) bool {
	fi, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil && (fi.IsDir() || fi.Mode().Type() == 0) // dir or worktree file
}

func handleGitGlobalConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		nameOut, _ := exec.Command("git", "config", "--global", "user.name").Output()
		emailOut, _ := exec.Command("git", "config", "--global", "user.email").Output()
		writeJSON(w, http.StatusOK, map[string]string{
			"name":  strings.TrimSpace(string(nameOut)),
			"email": strings.TrimSpace(string(emailOut)),
		})
		return
	}
	if r.Method == http.MethodPost {
		var req struct {
			Name  string `json:"name"`
			Email string `json:"email"`
		}
		decodeBody(r, &req)
		if req.Name != "" {
			exec.Command("git", "config", "--global", "user.name", strings.TrimSpace(req.Name)).Run()
		}
		if req.Email != "" {
			exec.Command("git", "config", "--global", "user.email", strings.TrimSpace(req.Email)).Run()
		}
		writeJSON(w, http.StatusOK, blob{"ok": true})
		return
	}
	writeErr(w, http.StatusMethodNotAllowed, "Method not allowed")
}

var conflictPairs = map[string]bool{
	"DD": true, "AU": true, "UD": true, "UA": true,
	"DU": true, "AA": true, "UU": true,
}

func gitStatusPayload(projPath string) blob {
	if !isGitRepo(projPath) {
		return gitStatusPayloadNonRepo()
	}
	out, _ := runGit(projPath, "status", "--porcelain=v1", "-b")
	lines := strings.Split(out, "\n")
	staged, unstaged, untracked, conflicts := []blob{}, []blob{}, []blob{}, []blob{}
	first := true
	for _, l := range lines {
		l = strings.TrimRight(l, "\r")
		if first {
			first = false // header line "## branch..." parsed by branchFromPorcelain
			continue
		}
		if len(l) < 3 {
			continue
		}
		x, y := l[0], l[1]
		file := strings.TrimSpace(l[3:])
		entry := blob{"x": string(x), "y": string(y), "path": file}
		if conflictPairs[string(x)+string(y)] || x == 'U' || y == 'U' {
			conflicts = append(conflicts, entry)
		} else if x == '?' && y == '?' {
			untracked = append(untracked, entry)
		} else {
			if x != ' ' && x != '?' {
				staged = append(staged, entry)
			}
			if y != ' ' && y != '?' {
				unstaged = append(unstaged, entry)
			}
		}
	}
	clean := len(staged) == 0 && len(unstaged) == 0 && len(untracked) == 0 && len(conflicts) == 0
	return blob{
		"is_git": true, "branch": branchFromPorcelain(out), "clean": clean,
		"staged": staged, "unstaged": unstaged, "untracked": untracked, "conflicts": conflicts,
		"has_conflicts": len(conflicts) > 0,
	}
}

func branchFromPorcelain(out string) string {
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "## ") {
			b := strings.TrimSpace(strings.TrimPrefix(l, "## "))
			if i := strings.Index(b, "..."); i >= 0 {
				b = b[:i]
			}
			return b
		}
	}
	return ""
}

func stageFiles(projPath string, files []string) error {
	if len(files) == 0 {
		_, err := runGit(projPath, "add", "-A")
		return err
	}
	for _, f := range files {
		clean, ferr := safeJoin(projPath, f)
		if ferr != nil {
			return ferr
		}
		rel, rerr := filepath.Rel(projPath, clean)
		if rerr != nil {
			return rerr
		}
		if _, gerr := runGit(projPath, "add", "--", rel); gerr != nil {
			return gerr
		}
	}
	return nil
}

func unstageFiles(projPath string, files []string) error {
	if len(files) == 0 {
		_, err := runGit(projPath, "reset")
		return err
	}
	for _, f := range files {
		clean, ferr := safeJoin(projPath, f)
		if ferr != nil {
			return ferr
		}
		rel, _ := filepath.Rel(projPath, clean)
		if _, gerr := runGit(projPath, "reset", "--", rel); gerr != nil {
			return gerr
		}
	}
	return nil
}

func stashRef(index int) (string, error) {
	if index < 0 {
		return "", fmt.Errorf("invalid stash index")
	}
	return fmt.Sprintf("stash@{%d}", index), nil
}

func graphCommits(projPath string, limit int) []blob {
	fmtStr := "%H%x1f%P%x1f%h%x1f%d%x1f%s%x1f%an%x1f%ad"
	out, err := runGit(projPath, "log", "--all", "--date-order",
		fmt.Sprintf("--pretty=format:%s", fmtStr), "--date=short", strconv.Itoa(-limit))
	if err != nil {
		return []blob{}
	}
	commits := []blob{}
	decoReplacer := strings.NewReplacer("(", "", ")", "")
	for _, line := range strings.Split(out, "\n") {
		parts := strings.Split(line, "\x1f")
		if len(parts) < 7 {
			continue
		}
		var refs []string
		if deco := strings.TrimSpace(decoReplacer.Replace(parts[3])); deco != "" {
			for _, rf := range strings.Split(deco, ",") {
				rf = strings.TrimSpace(rf)
				rf = strings.TrimPrefix(rf, "HEAD -> ")
				if rf != "" {
					refs = append(refs, rf)
				}
			}
		}
		if refs == nil {
			refs = []string{}
		}
		parents := strings.Fields(parts[1])
		if parents == nil {
			parents = []string{}
		}
		commits = append(commits, blob{
			"hash": parts[0], "short": parts[2],
			"parents": parents, "refs": refs,
			"subject": parts[4], "author": parts[5], "date": parts[6],
		})
	}
	return commits
}

func branchesPayload(projPath string) blob {
	cur, _ := runGit(projPath, "rev-parse", "--abbrev-ref", "HEAD")
	out, _ := runGit(projPath, "branch", "--format=%(refname:short)")
	list := []string{}
	for _, b := range strings.Split(out, "\n") {
		if strings.TrimSpace(b) != "" {
			list = append(list, strings.TrimSpace(b))
		}
	}
	return blob{"current": cur, "all": list}
}

type remoteInfo struct {
	Name  string `json:"name"`
	Fetch string `json:"fetch"`
	Push  string `json:"push"`
}

func remotesList(projPath string) []remoteInfo {
	out, _ := runGit(projPath, "remote", "-v")
	seen := map[string]*remoteInfo{}
	var order []string
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) >= 3 {
			name, u, kind := f[0], f[1], f[2]
			if seen[name] == nil {
				seen[name] = &remoteInfo{Name: name}
				order = append(order, name)
			}
			if strings.Contains(kind, "fetch") {
				seen[name].Fetch = u
			} else {
				seen[name].Push = u
			}
		}
	}
	var list []remoteInfo
	for _, n := range order {
		list = append(list, *seen[n])
	}
	return list
}

func stashesPayload(projPath string) []blob {
	out, _ := runGit(projPath, "stash", "list")
	list := []blob{}
	i := 0
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		label := line
		if idx := strings.Index(line, ":"); idx >= 0 {
			label = strings.TrimSpace(line[idx+1:])
		}
		list = append(list, blob{"index": i, "label": label})
		i++
	}
	return list
}

func handleGit(w http.ResponseWriter, r *http.Request) {
	cleanPath := strings.TrimPrefix(r.URL.Path, "/api/git/")
	cleanPath = strings.TrimPrefix(cleanPath, "/git/")
	if cleanPath == "" {
		writeErr(w, http.StatusBadRequest, "Invalid path")
		return
	}
	parts := strings.Split(cleanPath, "/")

	// Global identity endpoints are registered separately; skip them here.
	if parts[0] == "config" {
		handleGitGlobalConfig(w, r)
		return
	}

	pid := parts[0]
	action := ""
	if len(parts) >= 2 {
		action = parts[1]
	}

	proj := projectOr404(w, pid)
	if proj == nil {
		return
	}

	if !isGitRepo(proj.Path) {
		if action == "init" && r.Method == http.MethodPost {
			runGit(proj.Path, "init")
			runGit(proj.Path, "commit", "--allow-empty", "-m", "initial commit")
			writeJSON(w, http.StatusOK, blob{"ok": true})
			return
		}
		if action == "status" || action == "" {
			writeJSON(w, http.StatusOK, gitStatusPayloadNonRepo())
			return
		}
		writeJSON(w, http.StatusOK, blob{"ok": false, "detail": "not a git repository"})
		return
	}

	switch action {
	case "init":
		// Only reachable when the repo already exists; create handles fresh repos.
		writeJSON(w, http.StatusOK, blob{"ok": true, "out": "repository already initialized"})

	case "status":
		writeJSON(w, http.StatusOK, gitStatusPayload(proj.Path))

	case "log":
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit <= 0 || limit > 200 {
			limit = 30
		}
		fmtStr := "%H%x1f%an%x1f%ad%x1f%s"
		out, err := runGit(proj.Path, "log", fmt.Sprintf("--pretty=format:%s", fmtStr),
			"--date=short", fmt.Sprintf("-%d", limit))
		if err != nil {
			writeJSON(w, http.StatusOK, blob{"commits": []blob{}})
			return
		}
		commits := []blob{}
		for _, line := range strings.Split(out, "\n") {
			p := strings.Split(line, "\x1f")
			if len(p) == 4 {
				commits = append(commits, blob{
					"hash": p[0][:minInt(8, len(p[0]))], "author": p[1],
					"date": p[2], "subject": p[3],
				})
			}
		}
		writeJSON(w, http.StatusOK, blob{"commits": commits})

	case "graph":
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit <= 0 || limit > 300 {
			limit = 60
		}
		writeJSON(w, http.StatusOK, blob{
			"commits":  graphCommits(proj.Path, limit),
			"branches": branchesPayload(proj.Path),
			"remotes":  remotesList(proj.Path),
		})

	case "branches":
		writeJSON(w, http.StatusOK, branchesPayload(proj.Path))

	case "diff":
		target := r.URL.Query().Get("file")
		if target == "" {
			target = r.URL.Query().Get("path")
		}
		stagedQ := r.URL.Query().Get("staged") == "true" || r.URL.Query().Get("staged") == "1"
		args := []string{"diff", "--no-color"}
		if stagedQ {
			args = append(args, "--cached")
		}
		if target != "" {
			clean, jerr := safeJoin(proj.Path, target)
			if jerr != nil {
				writeErr(w, http.StatusBadRequest, jerr.Error())
				return
			}
			rel, _ := filepath.Rel(proj.Path, clean)
			args = append(args, "--", rel)
		}
		diff, _ := runGit(proj.Path, args...)
		writeJSON(w, http.StatusOK, blob{"diff": diff})

	case "stage":
		var req struct {
			Files []string `json:"files"`
		}
		decodeBody(r, &req)
		if err := stageFiles(proj.Path, req.Files); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, blob{"ok": true})

	case "unstage":
		var req struct {
			Files []string `json:"files"`
		}
		decodeBody(r, &req)
		if err := unstageFiles(proj.Path, req.Files); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, blob{"ok": true})

	case "commit":
		var req struct {
			Message string `json:"message"`
		}
		decodeBody(r, &req)
		out, err := runGit(proj.Path, "commit", "-m", req.Message)
		if err != nil {
			writeErr(w, http.StatusBadRequest, shortOut(out, "commit failed"))
			return
		}
		writeJSON(w, http.StatusOK, blob{"ok": true, "out": truncate(out, 400)})

	case "push":
		out, err := runGitOK(proj.Path, "push")
		writeOut(w, orText(out, "pushed"), err)

	case "pull":
		out, err := runGitOK(proj.Path, "pull")
		writeOut(w, orText(out, "pulled"), err)

	case "fetch":
		var req struct {
			Name string `json:"name"`
		}
		decodeBody(r, &req)
		remote := req.Name
		if remote == "" {
			remote = "origin"
		}
		out, err := runGitOK(proj.Path, "fetch", remote)
		writeOut(w, orText(out, "fetched from "+remote), err)

	case "checkout":
		var req struct {
			Ref string `json:"ref"`
		}
		decodeBody(r, &req)
		ref, rerr := safeRef(req.Ref)
		if rerr != nil {
			writeErr(w, http.StatusBadRequest, rerr.Error())
			return
		}
		out, err := runGitOK(proj.Path, "checkout", ref)
		writeOut(w, orText(out, "on "+ref), err)

	case "discard":
		var req struct {
			Ref string `json:"ref"`
		}
		decodeBody(r, &req)
		clean, jerr := safeJoin(proj.Path, req.Ref)
		if jerr != nil {
			writeErr(w, http.StatusBadRequest, jerr.Error())
			return
		}
		rel, _ := filepath.Rel(proj.Path, clean)
		out, err := runGitOK(proj.Path, "checkout", "--", rel)
		writeOut(w, orText(out, "discarded changes in "+rel), err)

	case "revert":
		var req struct {
			Ref string `json:"ref"`
		}
		decodeBody(r, &req)
		ref, rerr := safeRef(req.Ref)
		if rerr != nil {
			writeErr(w, http.StatusBadRequest, rerr.Error())
			return
		}
		out, err := runGitOK(proj.Path, "revert", "--no-edit", ref)
		writeOut(w, orText(out, "reverted "+ref), err)

	case "merge":
		var req struct {
			Ref string `json:"ref"`
		}
		decodeBody(r, &req)
		ref, rerr := safeRef(req.Ref)
		if rerr != nil {
			writeErr(w, http.StatusBadRequest, rerr.Error())
			return
		}
		out, err := runGitOK(proj.Path, "merge", "--no-edit", ref)
		writeOut(w, orText(out, "merged "+ref), err)

	case "resolve":
		var req struct {
			Path   string `json:"path"`
			Choice string `json:"choice"`
		}
		decodeBody(r, &req)
		clean, jerr := safeJoin(proj.Path, req.Path)
		if jerr != nil {
			writeErr(w, http.StatusBadRequest, jerr.Error())
			return
		}
		rel, _ := filepath.Rel(proj.Path, clean)
		flag := "--ours"
		if req.Choice == "theirs" {
			flag = "--theirs"
		}
		if _, gerr := runGit(proj.Path, "checkout", flag, "--", rel); gerr != nil {
			writeErr(w, http.StatusBadRequest, gerr.Error())
			return
		}
		stageFiles(proj.Path, []string{rel})
		writeJSON(w, http.StatusOK, blob{"ok": true, "out": fmt.Sprintf("resolved %s using %s", rel, req.Choice)})

	case "branch":
		if len(parts) >= 3 {
			sub := parts[2]
			var req struct {
				Name  string `json:"name"`
				Old   string `json:"old"`
				New   string `json:"new"`
				Force bool   `json:"force"`
			}
			decodeBody(r, &req)
			switch sub {
			case "create":
				name, rerr := safeRef(req.Name)
				if rerr != nil {
					writeErr(w, http.StatusBadRequest, rerr.Error())
					return
				}
				out, err := runGitOK(proj.Path, "branch", name)
				writeOut(w, orText(out, "created "+name), err)
			case "delete":
				name, rerr := safeRef(req.Name)
				if rerr != nil {
					writeErr(w, http.StatusBadRequest, rerr.Error())
					return
				}
				flag := "-d"
				if req.Force {
					flag = "-D"
				}
				out, err := runGitOK(proj.Path, "branch", flag, name)
				writeOut(w, orText(out, "deleted "+name), err)
			case "rename":
				old, rerr1 := safeRef(req.Old)
				new, rerr2 := safeRef(req.New)
				if rerr1 != nil || rerr2 != nil {
					writeErr(w, http.StatusBadRequest, "invalid branch name")
					return
				}
				out, err := runGitOK(proj.Path, "branch", "-m", old, new)
				writeOut(w, orText(out, old+" → "+new), err)
			default:
				writeErr(w, http.StatusNotFound, "unknown branch action")
			}
			return
		}
		var req struct {
			Name string `json:"name"`
		}
		decodeBody(r, &req)
		name, rerr := safeRef(req.Name)
		if rerr != nil {
			writeErr(w, http.StatusBadRequest, rerr.Error())
			return
		}
		out, err := runGitOK(proj.Path, "checkout", "-b", name)
		writeOut(w, orText(out, "created "+name), err)

	case "remotes":
		writeJSON(w, http.StatusOK, blob{"remotes": remotesList(proj.Path)})

	case "stash":
		if len(parts) >= 3 {
			sub := parts[2]
			var req struct {
				Index int `json:"index"`
			}
			decodeBody(r, &req)
			ref, rerr := stashRef(req.Index)
			if rerr != nil {
				writeErr(w, http.StatusBadRequest, rerr.Error())
				return
			}
			switch sub {
			case "apply", "pop", "drop":
				out, err := runGitOK(proj.Path, "stash", sub, ref)
				verbs := map[string]string{"apply": "applied", "pop": "popped", "drop": "dropped"}
				writeOut(w, orText(out, verbs[sub]+" "+ref), err)
			default:
				writeErr(w, http.StatusNotFound, "unknown stash action")
			}
			return
		}
		if r.Method == http.MethodGet {
			writeJSON(w, http.StatusOK, blob{"stashes": stashesPayload(proj.Path)})
			return
		}
		var req struct {
			Message string `json:"message"`
		}
		decodeBody(r, &req)
		args := []string{"stash", "push"}
		if req.Message != "" {
			args = append(args, "-m", req.Message)
		}
		out, err := runGitOK(proj.Path, args...)
		writeOut(w, orText(out, "stashed"), err)

	default:
		writeErr(w, http.StatusNotFound, "unknown git action: "+action)
	}
}

func gitStatusPayloadNonRepo() blob {
	return blob{
		"is_git": false, "branch": "", "clean": true,
		"staged": []blob{}, "unstaged": []blob{}, "untracked": []blob{}, "conflicts": []blob{},
		"has_conflicts": false,
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func shortOut(out, fallback string) string {
	out = strings.TrimSpace(out)
	if out == "" {
		return fallback
	}
	return truncate(out, 500)
}

func orText(out, fallback string) string {
	if strings.TrimSpace(out) == "" {
		return fallback
	}
	return out
}

// ------------------------------------------------------------ Terminal -----

func shellCommand(ctx context.Context, command string) *exec.Cmd {
	if bash, err := exec.LookPath("bash"); err == nil {
		return exec.CommandContext(ctx, bash, "-c", command)
	}
	if sh, err := exec.LookPath("sh"); err == nil {
		return exec.CommandContext(ctx, sh, "-c", command)
	}
	if runtime.GOOS == "windows" {
		return exec.CommandContext(ctx, "cmd.exe", "/c", command)
	}
	return exec.CommandContext(ctx, "/system/bin/sh", "-c", command)
}

func handleTerminal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	cleanPath := strings.TrimPrefix(r.URL.Path, "/api/terminal/")
	cleanPath = strings.TrimPrefix(cleanPath, "/terminal/")
	parts := strings.Split(cleanPath, "/")
	if len(parts) < 2 || parts[1] != "exec" {
		writeErr(w, http.StatusNotFound, "unknown terminal action")
		return
	}
	proj := projectOr404(w, parts[0])
	if proj == nil {
		return
	}
	var req struct {
		Command string  `json:"command"`
		Timeout float64 `json:"timeout"`
	}
	decodeBody(r, &req)
	command := strings.TrimSpace(req.Command)
	if command == "" {
		writeErr(w, http.StatusBadRequest, "command required")
		return
	}
	timeout := req.Timeout
	if timeout <= 0 || timeout > 120 {
		timeout = 30
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout*float64(time.Second)))
	defer cancel()
	cmd := shellCommand(ctx, command)
	cmd.Dir = proj.Path
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	code := 0
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else if ctx.Err() == context.DeadlineExceeded {
			stderr.WriteString(fmt.Sprintf("\nCommand timed out after %gs", timeout))
			code = -1
		} else {
			stderr.WriteString("\n" + err.Error())
			code = -1
		}
	}
	writeJSON(w, http.StatusOK, blob{
		"ok": code == 0, "code": code,
		"stdout": stdout.String(), "stderr": stderr.String(),
	})
}

// ------------------------------------------------- Models & LAN Scanner ---

type DiscoveredServer struct {
	Type    string      `json:"type"`
	Name    string      `json:"name"`
	Host    string      `json:"host"`
	Port    int         `json:"port"`
	BaseURL string      `json:"base_url"`
	Latency float64     `json:"latency_ms"`
	Models  []ModelItem `json:"models"`
}

type ModelItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Size string `json:"size,omitempty"`
}

func scanHostPort(client *http.Client, host string, port int) *DiscoveredServer {
	srvType := "ollama"
	path := "/api/tags"
	name := "Ollama"
	if port == 1234 {
		srvType, path, name = "lmstudio", "/v1/models", "LM Studio"
	} else if port == 8080 {
		srvType, path, name = "llamacpp", "/v1/models", "llama.cpp"
	}

	u := fmt.Sprintf("http://%s:%d%s", host, port, path)
	t0 := time.Now()
	resp, err := client.Get(u)
	if err != nil || resp.StatusCode != 200 {
		if resp != nil {
			resp.Body.Close()
		}
		return nil
	}
	lat := float64(time.Since(t0).Milliseconds())
	var body map[string]interface{}
	err = json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&body)
	resp.Body.Close()
	if err != nil {
		return nil
	}

	var models []ModelItem
	if srvType == "ollama" {
		if mList, ok := body["models"].([]interface{}); ok {
			for _, m := range mList {
				if mObj, ok := m.(map[string]interface{}); ok {
					mName, _ := mObj["name"].(string)
					models = append(models, ModelItem{ID: mName, Name: mName})
				}
			}
		}
	} else {
		if dList, ok := body["data"].([]interface{}); ok {
			for _, d := range dList {
				if dObj, ok := d.(map[string]interface{}); ok {
					mID, _ := dObj["id"].(string)
					models = append(models, ModelItem{ID: mID, Name: mID})
				}
			}
		}
	}

	return &DiscoveredServer{
		Type:    srvType,
		Name:    name,
		Host:    host,
		Port:    port,
		BaseURL: fmt.Sprintf("http://%s:%d/v1", host, port),
		Latency: lat,
		Models:  models,
	}
}

func localSubnetHosts() []string {
	hosts := []string{"127.0.0.1"}
	seenSubnets := map[string]bool{}
	ifaces, _ := net.Interfaces()
	for _, iface := range ifaces {
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			ipnet, ok := addr.(*net.IPNet)
			if !ok || ipnet.IP.IsLoopback() || ipnet.IP.To4() == nil {
				continue
			}
			ip := ipnet.IP.To4()
			prefix := fmt.Sprintf("%d.%d.%d.", ip[0], ip[1], ip[2])
			if seenSubnets[prefix] {
				continue
			}
			seenSubnets[prefix] = true
			for i := 1; i <= 254; i++ {
				hosts = append(hosts, fmt.Sprintf("%s%d", prefix, i))
			}
		}
	}
	return hosts
}

func handleScanLAN(w http.ResponseWriter, r *http.Request) {
	ports := []int{11434, 1234, 8080, 8000, 5000}
	hosts := localSubnetHosts()

	type task struct {
		host string
		port int
	}
	tasks := make(chan task)
	results := make(chan *DiscoveredServer, len(hosts)*len(ports))

	workers := 150
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			client := &http.Client{Timeout: 700 * time.Millisecond}
			for t := range tasks {
				if srv := scanHostPort(client, t.host, t.port); srv != nil {
					results <- srv
				}
			}
		}()
	}

	go func() {
		for _, h := range hosts {
			for _, p := range ports {
				tasks <- task{h, p}
			}
		}
		close(tasks)
		wg.Wait()
		close(results)
	}()

	results2 := []DiscoveredServer{}
	for srv := range results {
		results2 = append(results2, *srv)
	}
	writeJSON(w, http.StatusOK, blob{"servers": results2, "count": len(results2)})
}

func handleProbeHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Host string `json:"host"`
		Port int    `json:"port"`
		Type string `json:"type"`
	}
	decodeBody(r, &req)
	req.Host = strings.TrimSpace(req.Host)
	if req.Host == "" {
		writeErr(w, http.StatusBadRequest, "host required")
		return
	}
	if req.Port == 0 {
		req.Port = 11434
	}
	client := &http.Client{Timeout: 2 * time.Second}
	srv := scanHostPort(client, req.Host, req.Port)
	if srv == nil {
		writeErr(w, http.StatusNotFound, fmt.Sprintf("AI server unreachable at %s:%d", req.Host, req.Port))
		return
	}
	if req.Type != "" {
		srv.Type = req.Type
	}
	if srv.Models == nil {
		srv.Models = []ModelItem{}
	}
	writeJSON(w, http.StatusOK, srv)
}

func opencodeConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config/opencode/opencode.json")
}

func readOpencodeConfig() map[string]interface{} {
	var fullCfg map[string]interface{}
	b, _ := os.ReadFile(opencodeConfigPath())
	json.Unmarshal(b, &fullCfg)
	if fullCfg == nil {
		fullCfg = map[string]interface{}{}
	}
	return fullCfg
}

func writeOpencodeConfig(cfgMap map[string]interface{}, secret bool) error {
	os.MkdirAll(filepath.Dir(opencodeConfigPath()), 0755)
	out, err := json.MarshalIndent(cfgMap, "", "  ")
	if err != nil {
		return err
	}
	mode := os.FileMode(0644)
	if secret {
		mode = 0600
	}
	return os.WriteFile(opencodeConfigPath(), out, mode)
}

func maskSecret(t string) string {
	if t == "" {
		return ""
	}
	if len(t) <= 8 {
		return "****"
	}
	return fmt.Sprintf("%s...%s", t[:4], t[len(t)-4:])
}

func handleRegisterLocal(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProviderID string      `json:"provider_id"`
		Name       string      `json:"name"`
		BaseURL    string      `json:"base_url"`
		Models     []ModelItem `json:"models"`
		APIKey     string      `json:"api_key"`
	}
	decodeBody(r, &req)
	if req.ProviderID == "" || req.BaseURL == "" {
		writeErr(w, http.StatusBadRequest, "provider_id and base_url are required")
		return
	}

	fullCfg := readOpencodeConfig()
	providers, _ := fullCfg["provider"].(map[string]interface{})
	if providers == nil {
		providers = map[string]interface{}{}
		fullCfg["provider"] = providers
	}

	modelsMap := map[string]interface{}{}
	for _, m := range req.Models {
		modelsMap[m.ID] = blob{"name": m.Name}
	}

	key := req.APIKey
	if key == "" {
		key = "local"
	}
	hasSecret := key != "local"
	providers[req.ProviderID] = blob{
		"npm":  "@ai-sdk/openai-compatible",
		"name": req.Name,
		"options": blob{
			"baseURL": req.BaseURL,
			"apiKey":  key,
		},
		"models": modelsMap,
	}

	if err := writeOpencodeConfig(fullCfg, hasSecret); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Respond with a sanitized config so API keys never round-trip over HTTP.
	sanitized := deepCopyMasked(fullCfg)
	writeJSON(w, http.StatusOK, blob{"ok": true, "config": sanitized})
}

func deepCopyMasked(v interface{}) interface{} {
	switch t := v.(type) {
	case blob:
		out := blob{}
		for k, val := range t {
			out[k] = maskValue(k, val)
		}
		return out
	case map[string]interface{}:
		out := map[string]interface{}{}
		for k, val := range t {
			out[k] = maskValue(k, val)
		}
		return out
	case []interface{}:
		out := make([]interface{}, len(t))
		for i, val := range t {
			out[i] = deepCopyMasked(val)
		}
		return out
	default:
		return v
	}
}

func maskValue(k string, val interface{}) interface{} {
	if s, ok := val.(string); ok && k == "apiKey" && s != "" && s != "local" {
		return maskSecret(s)
	}
	return deepCopyMasked(val)
}

func getFallbackOpenCodeModels() map[string]interface{} {
	// Offline-safe catalog used when models.dev is unreachable and no cache
	// exists yet, so model browsing always has something to show.
	return map[string]interface{}{
		"opencode": map[string]interface{}{
			"id":   "opencode",
			"name": "OpenCode Zen",
			"models": map[string]interface{}{
				"claude-3-7-sonnet": blob{"name": "Claude 3.7 Sonnet (Thinking)"},
				"claude-3-5-sonnet": blob{"name": "Claude 3.5 Sonnet"},
				"claude-3-5-haiku":  blob{"name": "Claude 3.5 Haiku"},
				"gemini-2.5-pro":    blob{"name": "Gemini 2.5 Pro"},
				"gemini-2.5-flash":  blob{"name": "Gemini 2.5 Flash"},
				"gpt-4o":            blob{"name": "GPT-4o"},
				"o3-mini":           blob{"name": "o3-mini"},
				"deepseek-r1":       blob{"name": "DeepSeek R1 (Reasoning)"},
				"deepseek-v3":       blob{"name": "DeepSeek V3"},
				"qwen-2.5-coder":    blob{"name": "Qwen 2.5 Coder"},
				"glm-4.7":           blob{"name": "GLM 4.7"},
				"minimax-m3":        blob{"name": "MiniMax M3"},
			},
		},
		"google": map[string]interface{}{
			"id":   "google",
			"name": "Google Gemini",
			"models": map[string]interface{}{
				"gemini-2.5-pro":   blob{"name": "Gemini 2.5 Pro"},
				"gemini-2.5-flash": blob{"name": "Gemini 2.5 Flash"},
			},
		},
	}
}

func fetchLiveOpenCodeModels() map[string]interface{} {
	cachePath := filepath.Join(cfg.DataDir, "models_cache.json")

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("https://models.dev/api.json")
	if err == nil {
		if resp.StatusCode == 200 {
			var liveData map[string]interface{}
			if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&liveData); err == nil {
				resp.Body.Close()
				b, _ := json.Marshal(liveData)
				os.WriteFile(cachePath, b, 0644)
				return liveData
			}
		}
		resp.Body.Close()
	}

	var cachedData map[string]interface{}
	b, err := os.ReadFile(cachePath)
	if err == nil {
		json.Unmarshal(b, &cachedData)
	}
	if len(cachedData) > 0 {
		return cachedData
	}
	return getFallbackOpenCodeModels()
}

func handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		handleModelsWrite(w, r)
		return
	}
	if r.Method == http.MethodDelete {
		handleModelsDelete(w, r)
		return
	}
	pid := strings.TrimPrefix(r.URL.Path, "/api/models/")
	pid = strings.TrimSpace(pid)

	if pid != "" && pid != "global" && pid != "default" {
		inst, err := instMgr.Get(pid)
		if err == nil && inst != nil {
			target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", inst.Port))
			proxy := httputil.NewSingleHostReverseProxy(target)
			r.URL.Path = "/config/providers"
			proxy.ServeHTTP(w, r)
			return
		}
	}

	fullCfg := readOpencodeConfig()

	type ProvInfo struct {
		ID     string                 `json:"id"`
		Name   string                 `json:"name"`
		Models map[string]interface{} `json:"models"`
	}
	var list []ProvInfo

	allLiveProviders := fetchLiveOpenCodeModels()

	appendProv := func(id string, data map[string]interface{}, fallback string) {
		name, _ := data["name"].(string)
		if name == "" {
			name = fallback
		}
		mMap, _ := data["models"].(map[string]interface{})
		if mMap == nil {
			mMap = map[string]interface{}{}
		}
		list = append(list, ProvInfo{ID: id, Name: name, Models: mMap})
	}

	for _, id := range []string{"opencode", "google", "anthropic", "openai", "deepseek"} {
		if provLive, ok := allLiveProviders[id].(map[string]interface{}); ok {
			names := map[string]string{
				"opencode": "OpenCode Zen", "google": "Google Gemini",
				"anthropic": "Anthropic", "openai": "OpenAI", "deepseek": "DeepSeek",
			}
			appendProv(id, provLive, names[id])
		}
	}

	providersMap, _ := fullCfg["provider"].(map[string]interface{})
	for id, p := range providersMap {
		if pObj, ok := p.(map[string]interface{}); ok {
			appendProv(id, pObj, id)
		}
	}

	if list == nil {
		list = []ProvInfo{}
	}
	writeJSON(w, http.StatusOK, blob{"providers": list})
}

// model delete/add parity with the Python bridge -----------------------------

func handleFavorites(w http.ResponseWriter, r *http.Request) {
	favPath := filepath.Join(cfg.DataDir, "favorites.json")
	var favs struct {
		Favorites []string `json:"favorites"`
	}
	b, _ := os.ReadFile(favPath)
	json.Unmarshal(b, &favs)
	if favs.Favorites == nil {
		// Accept legacy bare-array format as well.
		var legacy []string
		if json.Unmarshal(b, &legacy) == nil && legacy != nil {
			favs.Favorites = legacy
		}
	}
	if favs.Favorites == nil {
		favs.Favorites = []string{}
	}

	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, favs)
		return
	}
	if r.Method == http.MethodPost {
		var req struct {
			ProviderID string `json:"provider_id"`
			ModelID    string `json:"model_id"`
		}
		decodeBody(r, &req)
		key := fmt.Sprintf("%s/%s", req.ProviderID, req.ModelID)
		added := true
		var next []string
		for _, f := range favs.Favorites {
			if f == key {
				added = false
			} else {
				next = append(next, f)
			}
		}
		if added {
			next = append(next, key)
		}
		favs.Favorites = next
		out, _ := json.Marshal(favs)
		os.WriteFile(favPath, out, 0600)
		writeJSON(w, http.StatusOK, blob{"favorites": next, "added": added})
		return
	}
	writeErr(w, http.StatusMethodNotAllowed, "Method not allowed")
}

// handleModelsWrite implements POST /api/models/{pid}: register or update a
// single provider/model pair directly in the global opencode config so it
// works even without a running engine.
func handleModelsWrite(w http.ResponseWriter, r *http.Request) {
	_ = strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/api/models/"), "models/") // pid unused: writes go to global config
	var req struct {
		ProviderID string                 `json:"provider_id"`
		ModelID    string                 `json:"model_id"`
		Options    map[string]interface{} `json:"options"`
		SetDefault bool                   `json:"set_default"`
	}
	decodeBody(r, &req)
	if req.ProviderID == "" || req.ModelID == "" {
		writeErr(w, http.StatusBadRequest, "provider_id and model_id are required")
		return
	}

	fullCfg := readOpencodeConfig()
	prov, _ := fullCfg["provider"].(map[string]interface{})
	if prov == nil {
		prov = map[string]interface{}{}
		fullCfg["provider"] = prov
	}
	pObj, _ := prov[req.ProviderID].(map[string]interface{})
	if pObj == nil {
		pObj = map[string]interface{}{
			"npm":  "@ai-sdk/openai-compatible",
			"name": req.ProviderID,
		}
		prov[req.ProviderID] = pObj
	}
	models, _ := pObj["models"].(map[string]interface{})
	if models == nil {
		models = map[string]interface{}{}
		pObj["models"] = models
	}
	entry, _ := models[req.ModelID].(map[string]interface{})
	if entry == nil {
		entry = map[string]interface{}{}
	}
	for k, v := range req.Options {
		if v != nil {
			entry[k] = v
		}
	}
	models[req.ModelID] = entry
	if req.SetDefault {
		fullCfg["model"] = req.ProviderID + "/" + req.ModelID
	}
	if err := writeOpencodeConfig(fullCfg, configHasSecrets(fullCfg)); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, blob{"ok": true})
}

// handleModelsDelete implements DELETE /api/models/{pid}.
func handleModelsDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProviderID string `json:"provider_id"`
		ModelID    string `json:"model_id"`
	}
	decodeBody(r, &req)
	fullCfg := readOpencodeConfig()
	if prov, ok := fullCfg["provider"].(map[string]interface{}); ok {
		if pObj, ok := prov[req.ProviderID].(map[string]interface{}); ok {
			if models, ok := pObj["models"].(map[string]interface{}); ok {
				delete(models, req.ModelID)
			}
		}
	}
	if fullCfg["model"] == req.ProviderID+"/"+req.ModelID {
		delete(fullCfg, "model")
	}
	if err := writeOpencodeConfig(fullCfg, configHasSecrets(fullCfg)); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, blob{"ok": true})
}

func configHasSecrets(cfgMap map[string]interface{}) bool {
	prov, _ := cfgMap["provider"].(map[string]interface{})
	for _, p := range prov {
		pObj, ok := p.(map[string]interface{})
		if !ok {
			continue
		}
		opts, _ := pObj["options"].(map[string]interface{})
		if opts == nil {
			continue
		}
		if k, ok := opts["apiKey"].(string); ok && k != "" && k != "local" {
			return true
		}
	}
	return false
}

// ---------------------------------------------------- Auth & Settings ---

func authJSONPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local/share/opencode/auth.json")
}

func readAuthJSON() map[string]interface{} {
	var authData map[string]interface{}
	b, _ := os.ReadFile(authJSONPath())
	json.Unmarshal(b, &authData)
	if authData == nil {
		authData = map[string]interface{}{}
	}
	return authData
}

func writeAuthJSON(data map[string]interface{}) {
	os.MkdirAll(filepath.Dir(authJSONPath()), 0700)
	out, _ := json.MarshalIndent(data, "", "  ")
	writeFileSecret(authJSONPath(), out)
}

func lookupProviderKey(id string) string {
	fullCfg := readOpencodeConfig()
	prov, _ := fullCfg["provider"].(map[string]interface{})
	if pObj, ok := prov[id].(map[string]interface{}); ok {
		if opts, ok := pObj["options"].(map[string]interface{}); ok {
			if k, ok := opts["apiKey"].(string); ok {
				return k
			}
		}
	}
	envNames := map[string]string{
		"gemini": "GEMINI_API_KEY", "openai": "OPENAI_API_KEY",
		"anthropic": "ANTHROPIC_API_KEY", "qwen": "DASHSCOPE_API_KEY",
		"glm": "ZHIPU_API_KEY",
	}
	if env, ok := envNames[id]; ok {
		return os.Getenv(env)
	}
	return ""
}

func credEntryFor(token string) string {
	return fmt.Sprintf("https://%s:x-oauth-basic@github.com\nhttps://oauth2:%s@github.com\n", token, token)
}

// saveGitHubCredentials merges PAT entries into ~/.git-credentials without
// destroying credentials for other hosts.
func saveGitHubCredentials(token string) {
	home, _ := os.UserHomeDir()
	credPath := filepath.Join(home, ".git-credentials")
	existing, _ := os.ReadFile(credPath)
	var kept []string
	for _, line := range strings.Split(string(existing), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		u, err := url.Parse(line)
		if err != nil || !strings.Contains(u.Host, "github.com") {
			kept = append(kept, line)
		}
	}
	if token != "" {
		kept = append(kept, strings.Split(strings.TrimSpace(credEntryFor(token)), "\n")...)
	}
	os.MkdirAll(home, 0700)
	writeFileSecret(credPath, []byte(strings.Join(kept, "\n")+"\n"))
	if len(kept) > 0 {
		out, _ := exec.Command("git", "config", "--global", "credential.helper").Output()
		if strings.TrimSpace(string(out)) == "" {
			exec.Command("git", "config", "--global", "credential.helper", "store").Run()
		}
	}
}

func gitIdentity() (string, string) {
	nameOut, _ := exec.Command("git", "config", "--global", "user.name").Output()
	emailOut, _ := exec.Command("git", "config", "--global", "user.email").Output()
	return strings.TrimSpace(string(nameOut)), strings.TrimSpace(string(emailOut))
}

func authStatusPayload() blob {
	authData := readAuthJSON()
	getTok := func(k string) string {
		if obj, ok := authData[k].(map[string]interface{}); ok {
			t, _ := obj["token"].(string)
			return t
		}
		return ""
	}
	opencodeToken := getTok("opencode")
	githubToken := getTok("github")
	name, email := gitIdentity()

	secrets := blob{}
	for _, id := range []string{"gemini", "openai", "anthropic", "qwen", "glm"} {
		k := lookupProviderKey(id)
		secrets[id] = blob{"configured": k != "", "preview": maskSecret(k)}
	}

	payload := blob{
		"opencode":       blob{"configured": opencodeToken != "", "preview": maskSecret(opencodeToken)},
		"github":         blob{"configured": githubToken != "", "preview": maskSecret(githubToken)},
		"git_user":       map[string]string{"name": name, "email": email},
		"opencode_local": findOpenCodeBinary() != "",
	}
	for k, v := range secrets {
		payload[k] = v
	}
	return payload
}

func handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, authStatusPayload())
}

func handleAuthToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProviderID string `json:"provider_id"`
		Token      string `json:"token"`
		BaseURL    string `json:"base_url"`
	}
	decodeBody(r, &req)
	provider := req.ProviderID
	if provider == "" {
		provider = "opencode"
	}
	tok := strings.TrimSpace(req.Token)

	switch provider {
	case "opencode":
		authData := readAuthJSON()
		authData["opencode"] = blob{"type": "api", "token": tok}
		writeAuthJSON(authData)
	case "github":
		authData := readAuthJSON()
		if tok == "" {
			delete(authData, "github")
		} else {
			authData["github"] = blob{"type": "token", "token": tok}
		}
		writeAuthJSON(authData)
		saveGitHubCredentials(tok)
	default:
		// Provider API keys go into the global opencode config.
		fullCfg := readOpencodeConfig()
		prov, _ := fullCfg["provider"].(map[string]interface{})
		if prov == nil {
			prov = map[string]interface{}{}
			fullCfg["provider"] = prov
		}
		pObj, _ := prov[provider].(map[string]interface{})
		if pObj == nil {
			pObj = map[string]interface{}{}
			prov[provider] = pObj
		}
		opts, _ := pObj["options"].(map[string]interface{})
		if opts == nil {
			opts = map[string]interface{}{}
			pObj["options"] = opts
		}
		if tok == "" {
			delete(opts, "apiKey")
		} else {
			opts["apiKey"] = tok
		}
		if req.BaseURL != "" {
			opts["baseURL"] = strings.TrimSpace(req.BaseURL)
		}
		if err := writeOpencodeConfig(fullCfg, configHasSecrets(fullCfg)); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	writeJSON(w, http.StatusOK, blob{"ok": true, "status": authStatusPayload()})
}

func getWorkspaceDir() string {
	settingsPath := filepath.Join(cfg.DataDir, "settings.json")
	var s struct {
		WorkspaceDir string `json:"workspace_dir"`
	}
	b, _ := os.ReadFile(settingsPath)
	json.Unmarshal(b, &s)
	if s.WorkspaceDir != "" {
		return s.WorkspaceDir
	}
	return cfg.WorkspaceDir
}

func handleSettingsWorkspace(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, blob{"workspace_dir": getWorkspaceDir()})
		return
	}
	if r.Method == http.MethodPost {
		var req struct {
			Path string `json:"path"`
		}
		decodeBody(r, &req)
		p, _ := filepath.Abs(req.Path)
		if req.Path == "" {
			writeErr(w, http.StatusBadRequest, "path required")
			return
		}
		os.MkdirAll(p, 0755)

		settingsPath := filepath.Join(cfg.DataDir, "settings.json")
		b, _ := json.Marshal(blob{"workspace_dir": p})
		os.WriteFile(settingsPath, b, 0600)

		writeJSON(w, http.StatusOK, blob{"ok": true, "workspace_dir": p})
		return
	}
	writeErr(w, http.StatusMethodNotAllowed, "Method not allowed")
}

// ------------------------------------- OpenCode Proxy & Standalone AI ---

type MsgInfo struct {
	ID         string                 `json:"id"`
	SessionID  string                 `json:"sessionID,omitempty"`
	Role       string                 `json:"role"`
	ModelID    string                 `json:"modelID,omitempty"`
	ProviderID string                 `json:"providerID,omitempty"`
	Cost       float64                `json:"cost,omitempty"`
	Tokens     map[string]interface{} `json:"tokens,omitempty"`
	Time       map[string]interface{} `json:"time,omitempty"`
}

type MsgPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type SessionMsg struct {
	Info  MsgInfo   `json:"info"`
	Parts []MsgPart `json:"parts"`
}

type SessionRecord struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
}

func getSessionFilePath(pid string) string {
	return filepath.Join(cfg.DataDir, fmt.Sprintf("sessions_%s.json", pid))
}

func getMessagesFilePath(pid, sid string) string {
	return filepath.Join(cfg.DataDir, fmt.Sprintf("msgs_%s_%s.json", pid, sid))
}

func loadSessions(pid string) []SessionRecord {
	var list []SessionRecord
	b, _ := os.ReadFile(getSessionFilePath(pid))
	json.Unmarshal(b, &list)
	if list == nil {
		list = []SessionRecord{}
	}
	return list
}

func saveSessions(pid string, list []SessionRecord) {
	b, _ := json.MarshalIndent(list, "", "  ")
	os.WriteFile(getSessionFilePath(pid), b, 0644)
}

func loadMessages(pid, sid string) []SessionMsg {
	var list []SessionMsg
	b, _ := os.ReadFile(getMessagesFilePath(pid, sid))
	json.Unmarshal(b, &list)
	if list == nil {
		list = []SessionMsg{}
	}
	return list
}

func saveMessages(pid, sid string, list []SessionMsg) {
	b, _ := json.MarshalIndent(list, "", "  ")
	os.WriteFile(getMessagesFilePath(pid, sid), b, 0644)
}

// executeAICall performs a chat completion via the OpenCode Zen cloud API so
// the standalone (engine-less) mode still offers real AI responses when the
// user configured a Zen token. Errors come back as readable assistant text.
func executeAICall(zenToken, model, prompt string) string {
	if zenToken == "" {
		return "⚠️ **OpenCode Zen Token Not Set**\n\nPlease go to **Settings ⚙️ ➔ AI Credentials & API Keys** and paste your OpenCode Zen Key (`zen_live_...`) to enable full AI coding and reasoning capabilities."
	}

	client := &http.Client{Timeout: 90 * time.Second}
	reqBody, _ := json.Marshal(map[string]interface{}{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": "You are OpenForge AI, an expert mobile software engineer."},
			{"role": "user", "content": prompt},
		},
	})

	req, err := http.NewRequest("POST", "https://opencode.ai/api/v1/chat/completions", bytes.NewBuffer(reqBody))
	if err != nil {
		return fmt.Sprintf("Request creation error: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+zenToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Sprintf("Network error contacting OpenCode API: %v", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	var respJSON struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	json.Unmarshal(bodyBytes, &respJSON)

	if respJSON.Error.Message != "" {
		return "OpenCode API Error: " + respJSON.Error.Message
	}
	if len(respJSON.Choices) > 0 {
		return respJSON.Choices[0].Message.Content
	}
	return truncate(string(bodyBytes), 2000)
}

// runStandaloneCompletion resolves the Zen token and fills in the pending
// assistant message stored under asstID.
func runStandaloneCompletion(pid, sid, asstID, model, prompt string) {
	home, _ := os.UserHomeDir()
	authData := readAuthJSONViaPath(filepath.Join(home, ".local/share/opencode/auth.json"))
	zenToken := ""
	if obj, ok := authData["opencode"].(map[string]interface{}); ok {
		zenToken, _ = obj["token"].(string)
	}
	if model == "" {
		model = "claude-3-7-sonnet"
	}

	reply := executeAICall(zenToken, model, prompt)
	compTime := time.Now().UnixMilli()

	all := loadMessages(pid, sid)
	for i := range all {
		if all[i].Info.ID == asstID {
			all[i].Parts = []MsgPart{{Type: "text", Text: reply}}
			all[i].Info.Time["completed"] = compTime
			all[i].Info.Tokens = map[string]interface{}{
				"input":  len(prompt) / 4,
				"output": len(reply) / 4,
			}
		}
	}
	saveMessages(pid, sid, all)
}

// readAuthJSONViaPath reads an auth.json at an explicit location.
func readAuthJSONViaPath(path string) map[string]interface{} {
	var authData map[string]interface{}
	b, _ := os.ReadFile(path)
	json.Unmarshal(b, &authData)
	if authData == nil {
		authData = map[string]interface{}{}
	}
	return authData
}

func handleOpenCode(w http.ResponseWriter, r *http.Request) {
	cleanPath := strings.TrimPrefix(r.URL.Path, "/api/oc/")
	cleanPath = strings.TrimPrefix(cleanPath, "/oc/")
	parts := strings.Split(cleanPath, "/")
	if len(parts) < 1 || parts[0] == "" {
		writeErr(w, http.StatusBadRequest, "Project ID required in /oc/{pid}/...")
		return
	}
	pid := parts[0]
	rest := "/" + strings.Join(parts[1:], "/")

	// 1. Forward to a running local OpenCode instance when available.
	inst, err := instMgr.Get(pid)
	if err == nil && inst != nil && isPortHealthy(inst.Port) {
		target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", inst.Port))
		proxy := httputil.NewSingleHostReverseProxy(target)
		proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, perr error) {
			writeErr(w, http.StatusBadGateway, "opencode instance unreachable")
		}
		r.URL.Path = rest
		r.Host = fmt.Sprintf("127.0.0.1:%d", inst.Port)
		proxy.ServeHTTP(w, r)
		return
	}

	// 2. Standalone fallback: Zen cloud completions + persistent sessions.
	const noEngine = "OpenCode engine is not installed — chat falls back to the Zen cloud engine (set a token in Settings). Projects, files, git and terminal still work."

	action := ""
	if len(parts) >= 2 {
		action = parts[1]
	}

	if action == "event" {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeErr(w, http.StatusInternalServerError, "Streaming unsupported")
			return
		}
		fmt.Fprintf(w, "retry: 4000\n\n")
		fmt.Fprintf(w, "data: {\"type\":\"connected\",\"engine\":false}\n\n")
		flusher.Flush()
		<-r.Context().Done()
		return
	}

	if action == "session" {
		switch {
		case len(parts) == 2 && r.Method == http.MethodGet:
			writeJSON(w, http.StatusOK, loadSessions(pid))
			return
		case len(parts) == 2 && r.Method == http.MethodPost:
			sid := fmt.Sprintf("ses_%d", time.Now().UnixMilli())
			s := SessionRecord{ID: sid, Title: "New Session", CreatedAt: time.Now()}
			list := append([]SessionRecord{s}, loadSessions(pid)...)
			saveSessions(pid, list)
			writeJSON(w, http.StatusOK, s)
			return
		case len(parts) == 3 && r.Method == http.MethodPatch:
			var req struct {
				Title string `json:"title"`
			}
			decodeBody(r, &req)
			sid := parts[2]
			list := loadSessions(pid)
			for i := range list {
				if list[i].ID == sid {
					if req.Title != "" {
						list[i].Title = req.Title
					}
					saveSessions(pid, list)
					writeJSON(w, http.StatusOK, blob{"ok": true})
					return
				}
			}
			writeErr(w, http.StatusNotFound, "session not found")
			return
		case len(parts) == 3 && r.Method == http.MethodDelete:
			sid := parts[2]
			list := loadSessions(pid)
			updated := list[:0]
			for _, s := range list {
				if s.ID != sid {
					updated = append(updated, s)
				}
			}
			saveSessions(pid, updated)
			os.Remove(getMessagesFilePath(pid, sid))
			writeJSON(w, http.StatusOK, blob{"ok": true})
			return
		}

		if len(parts) >= 3 {
			sid := parts[2]
			if len(parts) == 4 && parts[3] == "message" && r.Method == http.MethodGet {
				writeJSON(w, http.StatusOK, loadMessages(pid, sid))
				return
			}
			if len(parts) == 4 && (parts[3] == "prompt_async" || parts[3] == "prompt") && r.Method == http.MethodPost {
				var req struct {
					Parts []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"parts"`
					Model struct {
						ProviderID string `json:"providerID"`
						ModelID    string `json:"modelID"`
					} `json:"model"`
				}
				decodeBody(r, &req)
				userText := ""
				for _, p := range req.Parts {
					if p.Type == "text" {
						userText += p.Text
					}
				}

				now := time.Now().UnixMilli()
				userMsg := SessionMsg{
					Info: MsgInfo{
						ID:        fmt.Sprintf("msg_usr_%d", now),
						SessionID: sid,
						Role:      "user",
						Time:      map[string]interface{}{"created": now, "completed": now},
					},
					Parts: []MsgPart{{Type: "text", Text: userText}},
				}
				asstMsgID := fmt.Sprintf("msg_ast_%d", now+1)
				asstMsg := SessionMsg{
					Info: MsgInfo{
						ID:         asstMsgID,
						SessionID:  sid,
						Role:       "assistant",
						ModelID:    req.Model.ModelID,
						ProviderID: req.Model.ProviderID,
						Time:       map[string]interface{}{"created": now},
					},
					Parts: []MsgPart{{Type: "text", Text: "Connecting to OpenCode AI engine…"}},
				}

				msgs := loadMessages(pid, sid)
				msgs = append(msgs, userMsg, asstMsg)
				saveMessages(pid, sid, msgs)

				// Complete via the Zen cloud API in the background; the UI's
				// polling loop picks up the finished message automatically.
				go runStandaloneCompletion(pid, sid, asstMsgID, req.Model.ModelID, userText)

				writeJSON(w, http.StatusOK, blob{"ok": true, "sessionID": sid})
				return
			}
			if parts[3] == "abort" && r.Method == http.MethodPost {
				writeErr(w, http.StatusServiceUnavailable, noEngine)
				return
			}
		}
	}

	writeErr(w, http.StatusServiceUnavailable, noEngine)
}
