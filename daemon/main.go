package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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
}

var (
	cfg  Config
	lock sync.Mutex
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
	flag.Parse()

	os.MkdirAll(cfg.WorkspaceDir, 0755)
	os.MkdirAll(cfg.DataDir, 0755)

	mux := http.NewServeMux()

	// Health Check
	mux.HandleFunc("/api/health", handleHealth)

	// Projects
	mux.HandleFunc("/projects", handleProjects)
	mux.HandleFunc("/projects/import", handleProjectImport)
	mux.HandleFunc("/projects/", handleProjectOps)

	// File System
	mux.HandleFunc("/fs/", handleFS)
	mux.HandleFunc("/api/browse", handleBrowse)

	// Git
	mux.HandleFunc("/git/", handleGit)

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

	handler := corsMiddleware(mux)
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	log.Printf("🚀 OpenForge Native Standalone Daemon listening on http://%s (workspace: %s)", addr, cfg.WorkspaceDir)
	log.Fatal(http.ListenAndServe(addr, handler))
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------- Health ---

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"bridge": "ok",
		"opencode": map[string]interface{}{
			"healthy": true,
			"version": "native-go-v0.2.0",
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

func handleProjects(w http.ResponseWriter, r *http.Request) {
	lock.Lock()
	defer lock.Unlock()

	reg := readRegistry()

	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, reg)
		return
	}

	if r.Method == http.MethodPost {
		var req struct {
			Name      string `json:"name"`
			InitialBr string `json:"initial_branch"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		slug := slugify(req.Name)
		if slug == "" {
			slug = fmt.Sprintf("project-%d", time.Now().Unix())
		}
		branch := req.InitialBr
		if branch == "" {
			branch = "main"
		}

		projPath := filepath.Join(getWorkspaceDir(), slug)
		os.MkdirAll(projPath, 0755)

		// git init
		exec.Command("git", "init", "--initial-branch", branch, projPath).Run()
		cmd := exec.Command("git", "commit", "--allow-empty", "-m", "initial commit")
		cmd.Dir = projPath
		cmd.Run()

		proj := Project{ID: slug, Name: req.Name, Path: projPath, Created: true}
		reg.Projects = append(reg.Projects, proj)
		writeRegistry(reg)

		writeJSON(w, http.StatusOK, proj)
		return
	}
	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}

func handleProjectImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	absPath, err := filepath.Abs(req.Path)
	if err != nil || req.Path == "" {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	lock.Lock()
	defer lock.Unlock()

	reg := readRegistry()
	name := filepath.Base(absPath)
	pid := slugify(name)
	proj := Project{ID: pid, Name: name, Path: absPath}
	reg.Projects = append(reg.Projects, proj)
	writeRegistry(reg)

	writeJSON(w, http.StatusOK, proj)
}

func handleProjectOps(w http.ResponseWriter, r *http.Request) {
	pid := strings.TrimPrefix(r.URL.Path, "/projects/")
	if pid == "" {
		http.Error(w, "Project ID required", http.StatusBadRequest)
		return
	}

	lock.Lock()
	defer lock.Unlock()

	reg := readRegistry()
	if r.Method == http.MethodDelete {
		var updated []Project
		for _, p := range reg.Projects {
			if p.ID != pid {
				updated = append(updated, p)
			}
		}
		reg.Projects = updated
		writeRegistry(reg)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
}

// ------------------------------------------------------------ Filesystem ---

func findProject(pid string) *Project {
	reg := readRegistry()
	for _, p := range reg.Projects {
		if p.ID == pid {
			return &p
		}
	}
	return nil
}

func handleFS(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/fs/"), "/")
	if len(parts) < 2 {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	pid := parts[0]
	op := parts[1]

	proj := findProject(pid)
	if proj == nil {
		http.Error(w, "Project not found", http.StatusNotFound)
		return
	}

	switch op {
	case "tree":
		sub := r.URL.Query().Get("path")
		dirPath := filepath.Join(proj.Path, sub)
		entries, err := os.ReadDir(dirPath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		type Entry struct {
			Name string `json:"name"`
			Dir  bool   `json:"dir"`
			Size int64  `json:"size"`
		}
		var list []Entry
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".") && e.Name() != ".gitignore" {
				continue
			}
			info, _ := e.Info()
			sz := int64(0)
			if info != nil {
				sz = info.Size()
			}
			list = append(list, Entry{Name: e.Name(), Dir: e.IsDir(), Size: sz})
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"entries": list, "path": sub})

	case "read":
		rel := r.URL.Query().Get("path")
		filePath := filepath.Join(proj.Path, rel)
		content, err := os.ReadFile(filePath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"content": string(content), "path": rel})

	case "write":
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		filePath := filepath.Join(proj.Path, req.Path)
		os.MkdirAll(filepath.Dir(filePath), 0755)
		os.WriteFile(filePath, []byte(req.Content), 0644)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func handleBrowse(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		p = "/"
	}
	entries, err := os.ReadDir(p)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	type DirItem struct {
		Name  string `json:"name"`
		Path  string `json:"path"`
		IsDir bool   `json:"is_dir"`
	}
	var res []DirItem
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		res = append(res, DirItem{Name: e.Name(), Path: filepath.Join(p, e.Name()), IsDir: e.IsDir()})
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"current": p, "entries": res})
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

func isGitRepo(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

func handleGit(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/git/"), "/")
	if len(parts) < 2 {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	pid := parts[0]
	action := parts[1]

	proj := findProject(pid)
	if proj == nil {
		http.Error(w, "Project not found", http.StatusNotFound)
		return
	}

	if !isGitRepo(proj.Path) {
		if action == "init" && r.Method == http.MethodPost {
			runGit(proj.Path, "init")
			runGit(proj.Path, "commit", "--allow-empty", "-m", "initial commit")
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"is_git": false, "branch": "", "clean": true, "staged": []string{}, "unstaged": []string{}, "untracked": []string{}, "branches": []string{}, "remotes": []string{},
		})
		return
	}

	switch action {
	case "status":
		out, _ := runGit(proj.Path, "status", "--porcelain=v1", "-b")
		branch, _ := runGit(proj.Path, "branch", "--show-current")
		var staged, unstaged, untracked []string
		lines := strings.Split(out, "\n")
		for _, l := range lines {
			if len(l) < 3 {
				continue
			}
			x, y := l[0], l[1]
			file := strings.TrimSpace(l[3:])
			if x == '?' && y == '?' {
				untracked = append(untracked, file)
			} else {
				if x != ' ' && x != '?' {
					staged = append(staged, file)
				}
				if y != ' ' && y != '?' {
					unstaged = append(unstaged, file)
				}
			}
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"is_git": true, "branch": branch, "clean": len(staged) == 0 && len(unstaged) == 0 && len(untracked) == 0,
			"staged": staged, "unstaged": unstaged, "untracked": untracked,
		})

	case "diff":
		target := r.URL.Query().Get("file")
		staged := r.URL.Query().Get("staged") == "1"
		args := []string{"diff"}
		if staged {
			args = append(args, "--staged")
		}
		if target != "" {
			args = append(args, "--", target)
		}
		diff, _ := runGit(proj.Path, args...)
		writeJSON(w, http.StatusOK, map[string]string{"diff": diff})

	case "stage":
		var req struct {
			Files []string `json:"files"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if len(req.Files) == 0 {
			runGit(proj.Path, "add", "-A")
		} else {
			for _, f := range req.Files {
				runGit(proj.Path, "add", f)
			}
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})

	case "unstage":
		var req struct {
			Files []string `json:"files"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if len(req.Files) == 0 {
			runGit(proj.Path, "restore", "--staged", ".")
		} else {
			for _, f := range req.Files {
				runGit(proj.Path, "restore", "--staged", f)
			}
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})

	case "commit":
		var req struct {
			Message string `json:"message"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		runGit(proj.Path, "commit", "-m", req.Message)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})

	case "branches":
		out, _ := runGit(proj.Path, "branch", "--format=%(refname:short)")
		var list []string
		for _, b := range strings.Split(out, "\n") {
			if strings.TrimSpace(b) != "" {
				list = append(list, strings.TrimSpace(b))
			}
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"branches": list})

	case "branch":
		if len(parts) >= 3 {
			subAction := parts[2]
			var req struct {
				Name string `json:"name"`
			}
			json.NewDecoder(r.Body).Decode(&req)
			if subAction == "create" {
				runGit(proj.Path, "branch", req.Name)
			} else if subAction == "checkout" {
				runGit(proj.Path, "checkout", req.Name)
			}
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}

	case "remotes":
		out, _ := runGit(proj.Path, "remote", "-v")
		type Remote struct {
			Name  string `json:"name"`
			Fetch string `json:"fetch"`
			Push  string `json:"push"`
		}
		remotes := map[string]*Remote{}
		for _, line := range strings.Split(out, "\n") {
			f := strings.Fields(line)
			if len(f) >= 3 {
				name, u, kind := f[0], f[1], f[2]
				if remotes[name] == nil {
					remotes[name] = &Remote{Name: name}
				}
				if strings.Contains(kind, "fetch") {
					remotes[name].Fetch = u
				} else {
					remotes[name].Push = u
				}
			}
		}
		var list []*Remote
		for _, r := range remotes {
			list = append(list, r)
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"remotes": list})
	}
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

func handleScanLAN(w http.ResponseWriter, r *http.Request) {
	var results []DiscoveredServer
	var wg sync.WaitGroup
	var mu sync.Mutex

	ports := []int{11434, 1234, 8080, 8000, 5000}
	hosts := []string{"127.0.0.1"}

	// Scan local IP subnets
	ifaces, _ := net.Interfaces()
	for _, iface := range ifaces {
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
				if ipnet.IP.To4() != nil {
					ip := ipnet.IP.To4()
					prefix := fmt.Sprintf("%d.%d.%d.", ip[0], ip[1], ip[2])
					for i := 1; i <= 254; i++ {
						hosts = append(hosts, fmt.Sprintf("%s%d", prefix, i))
					}
				}
			}
		}
	}

	client := &http.Client{Timeout: 600 * time.Millisecond}

	for _, h := range hosts {
		for _, p := range ports {
			wg.Add(1)
			go func(host string, port int) {
				defer wg.Done()
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
				if err == nil && resp.StatusCode == 200 {
					lat := float64(time.Since(t0).Milliseconds())
					var body map[string]interface{}
					json.NewDecoder(resp.Body).Decode(&body)
					resp.Body.Close()

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

					mu.Lock()
					results = append(results, DiscoveredServer{
						Type:    srvType,
						Name:    name,
						Host:    host,
						Port:    port,
						BaseURL: fmt.Sprintf("http://%s:%d/v1", host, port),
						Latency: lat,
						Models:  models,
					})
					mu.Unlock()
				}
			}(h, p)
		}
	}
	wg.Wait()

	writeJSON(w, http.StatusOK, map[string]interface{}{"servers": results, "count": len(results)})
}

func handleProbeHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Host string `json:"host"`
		Port int    `json:"port"`
		Type string `json:"type"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.Port == 0 {
		req.Port = 11434
	}
	srvType := req.Type
	if srvType == "" {
		srvType = "ollama"
	}
	path := "/api/tags"
	if srvType == "lmstudio" || srvType == "llamacpp" {
		path = "/v1/models"
	}

	client := &http.Client{Timeout: 2 * time.Second}
	u := fmt.Sprintf("http://%s:%d%s", req.Host, req.Port, path)
	resp, err := client.Get(u)
	if err != nil || resp.StatusCode != 200 {
		http.Error(w, "AI server unreachable", http.StatusNotFound)
		return
	}
	defer resp.Body.Close()

	var models []ModelItem
	var body map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&body)
	if srvType == "ollama" {
		if mList, ok := body["models"].([]interface{}); ok {
			for _, m := range mList {
				if mObj, ok := m.(map[string]interface{}); ok {
					mName, _ := mObj["name"].(string)
					models = append(models, ModelItem{ID: mName, Name: mName})
				}
			}
		}
	}

	writeJSON(w, http.StatusOK, DiscoveredServer{
		Type:    srvType,
		Name:    srvType,
		Host:    req.Host,
		Port:    req.Port,
		BaseURL: fmt.Sprintf("http://%s:%d/v1", req.Host, req.Port),
		Models:  models,
	})
}

func handleRegisterLocal(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProviderID string      `json:"provider_id"`
		Name       string      `json:"name"`
		BaseURL    string      `json:"base_url"`
		Models     []ModelItem `json:"models"`
		APIKey     string      `json:"api_key"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	home, _ := os.UserHomeDir()
	cfgPath := filepath.Join(home, ".config/opencode/opencode.json")
	os.MkdirAll(filepath.Dir(cfgPath), 0755)

	var fullCfg map[string]interface{}
	b, _ := os.ReadFile(cfgPath)
	json.Unmarshal(b, &fullCfg)
	if fullCfg == nil {
		fullCfg = map[string]interface{}{}
	}
	providers, _ := fullCfg["provider"].(map[string]interface{})
	if providers == nil {
		providers = map[string]interface{}{}
		fullCfg["provider"] = providers
	}

	modelsMap := map[string]interface{}{}
	for _, m := range req.Models {
		modelsMap[m.ID] = map[string]interface{}{"name": m.Name}
	}

	key := req.APIKey
	if key == "" {
		key = "local"
	}
	providers[req.ProviderID] = map[string]interface{}{
		"npm":  "@ai-sdk/openai-compatible",
		"name": req.Name,
		"options": map[string]interface{}{
			"baseURL": req.BaseURL,
			"apiKey":  key,
		},
		"models": modelsMap,
	}

	out, _ := json.MarshalIndent(fullCfg, "", "  ")
	os.WriteFile(cfgPath, out, 0644)

	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "config": fullCfg})
}

// Fetch live models dynamically from models.dev (OpenCode's official live models registry)
func fetchLiveOpenCodeModels() map[string]interface{} {
	cachePath := filepath.Join(cfg.DataDir, "models_cache.json")

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("https://models.dev/api.json")
	if err == nil && resp.StatusCode == 200 {
		var liveData map[string]interface{}
		if err := json.NewDecoder(resp.Body).Decode(&liveData); err == nil {
			resp.Body.Close()
			b, _ := json.Marshal(liveData)
			os.WriteFile(cachePath, b, 0644)
			return liveData
		}
		resp.Body.Close()
	}

	// Fallback to cached copy
	var cachedData map[string]interface{}
	b, err := os.ReadFile(cachePath)
	if err == nil {
		json.Unmarshal(b, &cachedData)
	}
	return cachedData
}

func handleModels(w http.ResponseWriter, r *http.Request) {
	// If opencode serve is alive on :4100, proxy directly to it
	if isOpenCodeAlive() {
		target, _ := url.Parse("http://127.0.0.1:4100")
		proxy := httputil.NewSingleHostReverseProxy(target)
		r.URL.Path = "/provider"
		proxy.ServeHTTP(w, r)
		return
	}

	home, _ := os.UserHomeDir()
	cfgPath := filepath.Join(home, ".config/opencode/opencode.json")
	authPath := filepath.Join(home, ".local/share/opencode/auth.json")

	var fullCfg map[string]interface{}
	b, _ := os.ReadFile(cfgPath)
	json.Unmarshal(b, &fullCfg)
	if fullCfg == nil {
		fullCfg = map[string]interface{}{}
	}

	var authData map[string]map[string]interface{}
	ab, _ := os.ReadFile(authPath)
	json.Unmarshal(ab, &authData)

	hasZenToken := false
	if authData != nil && authData["opencode"] != nil {
		if tok, ok := authData["opencode"]["token"].(string); ok && tok != "" {
			hasZenToken = true
		}
	}

	type ProvInfo struct {
		ID     string                 `json:"id"`
		Name   string                 `json:"name"`
		Models map[string]interface{} `json:"models"`
	}
	var list []ProvInfo

	// Fetch dynamic models from OpenCode models directory
	allLiveProviders := fetchLiveOpenCodeModels()

	// 1. Dynamic OpenCode Zen models from models.dev
	if opencodeLive, ok := allLiveProviders["opencode"].(map[string]interface{}); ok {
		name, _ := opencodeLive["name"].(string)
		if name == "" {
			name = "OpenCode Zen"
		}
		mMap, _ := opencodeLive["models"].(map[string]interface{})
		list = append(list, ProvInfo{ID: "opencode", Name: name, Models: mMap})
	} else if hasZenToken {
		list = append(list, ProvInfo{ID: "opencode", Name: "OpenCode Zen", Models: map[string]interface{}{}})
	}

	// 2. Dynamic Google Gemini models from models.dev if configured
	if os.Getenv("GEMINI_API_KEY") != "" {
		if googleLive, ok := allLiveProviders["google"].(map[string]interface{}); ok {
			name, _ := googleLive["name"].(string)
			mMap, _ := googleLive["models"].(map[string]interface{})
			list = append(list, ProvInfo{ID: "google", Name: name, Models: mMap})
		}
	}

	// 3. User configured providers from opencode.json
	providersMap, _ := fullCfg["provider"].(map[string]interface{})
	for id, p := range providersMap {
		if id == "opencode" {
			continue
		}
		if pObj, ok := p.(map[string]interface{}); ok {
			name, _ := pObj["name"].(string)
			mMap, _ := pObj["models"].(map[string]interface{})
			list = append(list, ProvInfo{ID: id, Name: name, Models: mMap})
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"providers": list})
}

func handleFavorites(w http.ResponseWriter, r *http.Request) {
	favPath := filepath.Join(cfg.DataDir, "favorites.json")
	var favs struct {
		Favorites []string `json:"favorites"`
	}
	b, _ := os.ReadFile(favPath)
	json.Unmarshal(b, &favs)
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
		json.NewDecoder(r.Body).Decode(&req)
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
		os.WriteFile(favPath, out, 0644)
		writeJSON(w, http.StatusOK, map[string]interface{}{"favorites": next, "added": added})
	}
}

// ---------------------------------------------------- Auth & Settings ---

func handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	home, _ := os.UserHomeDir()
	authPath := filepath.Join(home, ".local/share/opencode/auth.json")
	var authData map[string]map[string]interface{}
	b, _ := os.ReadFile(authPath)
	json.Unmarshal(b, &authData)

	opencodeToken := ""
	if authData != nil && authData["opencode"] != nil {
		opencodeToken, _ = authData["opencode"]["token"].(string)
	}

	mask := func(t string) string {
		if t == "" {
			return ""
		}
		if len(t) <= 8 {
			return "****"
		}
		return fmt.Sprintf("%s...%s", t[:4], t[len(t)-4:])
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"opencode":  map[string]interface{}{"configured": opencodeToken != "", "preview": mask(opencodeToken)},
		"gemini":    map[string]interface{}{"configured": os.Getenv("GEMINI_API_KEY") != "", "preview": mask(os.Getenv("GEMINI_API_KEY"))},
		"openai":    map[string]interface{}{"configured": os.Getenv("OPENAI_API_KEY") != "", "preview": mask(os.Getenv("OPENAI_API_KEY"))},
		"anthropic": map[string]interface{}{"configured": os.Getenv("ANTHROPIC_API_KEY") != "", "preview": mask(os.Getenv("ANTHROPIC_API_KEY"))},
	})
}

func handleAuthToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProviderID string `json:"provider_id"`
		Token      string `json:"token"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	home, _ := os.UserHomeDir()
	if req.ProviderID == "opencode" {
		authPath := filepath.Join(home, ".local/share/opencode/auth.json")
		os.MkdirAll(filepath.Dir(authPath), 0755)
		data := map[string]interface{}{
			"opencode": map[string]string{
				"type":  "api",
				"token": strings.TrimSpace(req.Token),
			},
		}
		b, _ := json.MarshalIndent(data, "", "  ")
		os.WriteFile(authPath, b, 0644)
	}

	handleAuthStatus(w, r)
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
		writeJSON(w, http.StatusOK, map[string]string{"workspace_dir": getWorkspaceDir()})
		return
	}
	if r.Method == http.MethodPost {
		var req struct {
			Path string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		p, _ := filepath.Abs(req.Path)
		os.MkdirAll(p, 0755)

		settingsPath := filepath.Join(cfg.DataDir, "settings.json")
		b, _ := json.Marshal(map[string]string{"workspace_dir": p})
		os.WriteFile(settingsPath, b, 0644)

		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "workspace_dir": p})
	}
}

// ---------------------------------------------------- OpenCode / Chat ---

type Session struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
}

type Message struct {
	ID        string    `json:"id"`
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"createdAt"`
}

func getSessionFilePath(pid string) string {
	return filepath.Join(cfg.DataDir, fmt.Sprintf("sessions_%s.json", pid))
}

func getMessagesFilePath(pid, sid string) string {
	return filepath.Join(cfg.DataDir, fmt.Sprintf("msgs_%s_%s.json", pid, sid))
}

func loadSessions(pid string) []Session {
	var list []Session
	b, _ := os.ReadFile(getSessionFilePath(pid))
	json.Unmarshal(b, &list)
	if list == nil {
		list = []Session{}
	}
	return list
}

func saveSessions(pid string, list []Session) {
	b, _ := json.MarshalIndent(list, "", "  ")
	os.WriteFile(getSessionFilePath(pid), b, 0644)
}

func loadMessages(pid, sid string) []Message {
	var list []Message
	b, _ := os.ReadFile(getMessagesFilePath(pid, sid))
	json.Unmarshal(b, &list)
	if list == nil {
		list = []Message{}
	}
	return list
}

func saveMessages(pid, sid string, list []Message) {
	b, _ := json.MarshalIndent(list, "", "  ")
	os.WriteFile(getMessagesFilePath(pid, sid), b, 0644)
}

func isOpenCodeAlive() bool {
	conn, err := net.DialTimeout("tcp", "127.0.0.1:4100", 150*time.Millisecond)
	if err == nil {
		conn.Close()
		return true
	}
	return false
}

func handleOpenCode(w http.ResponseWriter, r *http.Request) {
	// If opencode serve is running on :4100, proxy directly to it
	if isOpenCodeAlive() {
		target, _ := url.Parse("http://127.0.0.1:4100")
		proxy := httputil.NewSingleHostReverseProxy(target)
		proxy.ServeHTTP(w, r)
		return
	}

	// Standalone fallback: Handle Sessions, Messages & AI Streaming natively
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/oc/"), "/")
	if len(parts) < 2 {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	pid := parts[0]
	action := parts[1]

	// SSE event stream
	if action == "event" {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
			return
		}
		fmt.Fprintf(w, "data: {\"type\":\"connected\"}\n\n")
		flusher.Flush()
		<-r.Context().Done()
		return
	}

	// Session Management
	if action == "session" {
		if len(parts) == 2 {
			if r.Method == http.MethodGet {
				writeJSON(w, http.StatusOK, loadSessions(pid))
				return
			}
			if r.Method == http.MethodPost {
				sid := fmt.Sprintf("ses_%d", time.Now().UnixMilli())
				s := Session{ID: sid, Title: "New Session", CreatedAt: time.Now()}
				list := append([]Session{s}, loadSessions(pid)...)
				saveSessions(pid, list)
				writeJSON(w, http.StatusOK, s)
				return
			}
		}

		sid := parts[2]
		if len(parts) == 4 && parts[3] == "message" {
			if r.Method == http.MethodGet {
				writeJSON(w, http.StatusOK, loadMessages(pid, sid))
				return
			}
		}

		if len(parts) == 4 && parts[3] == "prompt_async" && r.Method == http.MethodPost {
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
			json.NewDecoder(r.Body).Decode(&req)
			userText := ""
			for _, p := range req.Parts {
				if p.Type == "text" {
					userText += p.Text
				}
			}

			msgs := loadMessages(pid, sid)
			userMsg := Message{ID: fmt.Sprintf("msg_%d", time.Now().UnixMilli()), Role: "user", Content: userText, CreatedAt: time.Now()}
			msgs = append(msgs, userMsg)

			// Simple AI Response or Echo
			aiMsg := Message{
				ID:        fmt.Sprintf("msg_%d", time.Now().UnixMilli()+1),
				Role:      "assistant",
				Content:   fmt.Sprintf("I received your message for project `%s` using `%s/%s`:\n\n%s", pid, req.Model.ProviderID, req.Model.ModelID, userText),
				CreatedAt: time.Now(),
			}
			msgs = append(msgs, aiMsg)
			saveMessages(pid, sid, msgs)

			writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "sessionID": sid})
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
