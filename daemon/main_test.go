package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func tempCfg(t *testing.T) {
	t.Helper()
	root := t.TempDir()
	cfg = Config{
		Port:         0,
		Host:         "127.0.0.1",
		WorkspaceDir: filepath.Join(root, "workspace"),
		DataDir:      filepath.Join(root, "data"),
		WebDir:       "",
		Token:        "",
	}
	os.MkdirAll(cfg.WorkspaceDir, 0755)
	os.MkdirAll(cfg.DataDir, 0755)
	instMgr = NewManager()
}

// setTestGitIdentity gives spawned `git commit` calls (including ones run
// inside the daemon under test) an author identity — required on CI runners
// where no global git config exists.
func setTestGitIdentity(t *testing.T) {
	t.Helper()
	t.Setenv("GIT_AUTHOR_NAME", "test")
	t.Setenv("GIT_AUTHOR_EMAIL", "t@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "test")
	t.Setenv("GIT_COMMITTER_EMAIL", "t@example.com")
}

func TestNormalizeEngineProviders(t *testing.T) {
	// Engine shape: models as an ARRAY of objects (this previously broke the
	// UI into "0","1",... ids) — plus a map-shaped provider for robustness.
	body := map[string]interface{}{
		"default": "opencode/grok-code",
		"providers": []interface{}{
			map[string]interface{}{
				"id":   "opencode",
				"name": "OpenCode Zen",
				"models": []interface{}{
					map[string]interface{}{"id": "grok-code", "name": "Grok Code"},
					map[string]interface{}{"id": "claude-sonnet-4-5"},
				},
			},
			map[string]interface{}{
				"id":     "custom",
				"name":   "Custom",
				"models": map[string]interface{}{"m1": map[string]interface{}{"name": "Model One"}},
			},
		},
	}
	provs := normalizeEngineProviders(body)
	if len(provs) != 2 {
		t.Fatalf("want 2 providers, got %d", len(provs))
	}
	zen := provs[0]
	if zen.ID != "opencode" || zen.Name != "OpenCode Zen" || zen.Source != "engine" {
		t.Fatalf("bad provider header: %+v", zen)
	}
	if m, ok := zen.Models["grok-code"].(map[string]interface{}); !ok || m["name"] != "Grok Code" {
		t.Fatalf("zen models wrong: %v", zen.Models)
	}
	if m, _ := zen.Models["claude-sonnet-4-5"].(map[string]interface{}); m == nil || m["name"] != "claude-sonnet-4-5" {
		t.Fatalf("missing-name model not defaulted: %v", zen.Models)
	}
	if m, _ := provs[1].Models["m1"].(map[string]interface{}); m == nil || m["name"] != "Model One" {
		t.Fatalf("map-shaped models not normalized: %v", provs[1].Models)
	}
}

func TestFetchEngineProvidersViaFakeServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/config/providers" {
			w.Write([]byte(`{"providers":[{"id":"opencode","name":"OpenCode Zen","models":[{"id":"grok-code","name":"Grok Code"}]}]}`))
			return
		}
		if r.URL.Path == "/global/health" {
			w.WriteHeader(200)
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()
	port := srvPort(t, srv)
	inst := &Instance{PID: "fake", Port: port}
	provs, ok := fetchEngineProviders(inst)
	if !ok || len(provs) != 1 || provs[0].ID != "opencode" {
		t.Fatalf("engine fetch failed: ok=%v provs=%v", ok, provs)
	}
	if _, has := provs[0].Models["grok-code"]; !has {
		t.Fatalf("grok-code missing: %v", provs[0].Models)
	}
}

func srvPort(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := strconv.Atoi(u.Port())
	return p
}

func TestSafeJoinRejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	if p, err := safeJoin(dir, "../evil.txt"); err == nil || !strings.Contains(p, dir) && err == nil {
		t.Fatalf("expected error for ../escape, got %q err=%v", p, err)
	}
	p, err := safeJoin(dir, "sub/../other/file.txt")
	if err != nil {
		t.Fatalf("valid relative path rejected: %v", err)
	}
	want, _ := filepath.Abs(filepath.Join(dir, "other", "file.txt"))
	if filepath.Clean(p) != want {
		t.Fatalf("got %s want %s", p, want)
	}
}

func TestSafeRef(t *testing.T) {
	for _, ok := range []string{"main", "feature/x", "v1.2.3", "abc123"} {
		if _, err := safeRef(ok); err != nil {
			t.Fatalf("safeRef(%q) should pass: %v", ok, err)
		}
	}
	for _, bad := range []string{"-rf", "--all", "", "a b", "x..y@{z}"} {
		if _, err := safeRef(bad); err == nil {
			t.Fatalf("safeRef(%q) should fail", bad)
		}
	}
}

func do(r http.Handler, method, path string, body string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func jsonBody(t *testing.T, w *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("invalid JSON response: %v — %s", err, w.Body.String())
	}
	return m
}

func TestProjectsCRUDAndRegistrySlug(t *testing.T) {
	tempCfg(t)
	setTestGitIdentity(t) // project creation runs an initial git commit
	h := http.HandlerFunc(handleProjects)

	w := do(h, "POST", "/api/projects", `{"name":"My App!","branch":"main"}`, nil)
	if w.Code != 200 {
		t.Fatalf("create failed: %d %s", w.Code, w.Body.String())
	}
	proj := jsonBody(t, w)
	if proj["id"] != "my-app" {
		t.Fatalf("unexpected slug: %v", proj["id"])
	}

	w = do(h, "GET", "/api/projects", "", nil)
	list := jsonBody(t, w)
	items := list["projects"].([]interface{})
	if len(items) != 1 {
		t.Fatalf("want 1 project, got %d", len(items))
	}

	// Duplicate name must get unique slug instead of silently merging.
	w = do(h, "POST", "/api/projects", `{"name":"my app"}`, nil)
	if got := jsonBody(t, w)["id"]; got == "my-app" {
		t.Fatal("duplicate slug not deduplicated")
	}

	w = do(http.HandlerFunc(handleProjectOps), "DELETE", "/api/projects/my-app", "", nil)
	if w.Code != 200 {
		t.Fatalf("delete failed: %s", w.Body.String())
	}
	w = do(h, "GET", "/api/projects", "", nil)
	items = jsonBody(t, w)["projects"].([]interface{})
	if len(items) != 1 {
		t.Fatalf("delete did not remove project: %d remain", len(items))
	}
}

func makeGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=t@example.com",
			"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=t@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
	run("init", "-b", "main")
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello\n"), 0644)
	run("add", ".")
	run("commit", "-m", "first")
	return dir
}

func registerProject(t *testing.T, path string) string {
	t.Helper()
	lock.Lock()
	reg := readRegistry()
	reg.Projects = append(reg.Projects, Project{ID: "p1", Name: "p1", Path: path})
	writeRegistry(reg)
	lock.Unlock()
	return "p1"
}

func TestGitWorkflows(t *testing.T) {
	tempCfg(t)
	setTestGitIdentity(t)
	repo := makeGitRepo(t)
	pid := registerProject(t, repo)
	h := http.HandlerFunc(handleGit)

	// status
	w := do(h, "GET", "/git/"+pid+"/status", "", nil)
	st := jsonBody(t, w)
	if st["is_git"] != true || st["branch"] != "main" {
		t.Fatalf("bad status payload: %s", w.Body.String())
	}

	// commit → appears in log and graph
	os.WriteFile(filepath.Join(repo, "b.txt"), []byte("world\n"), 0644)
	w = do(h, "POST", "/git/"+pid+"/stage", `{"files":[]}`, nil)
	if w.Code != 200 {
		t.Fatalf("stage failed: %s", w.Body.String())
	}
	staged := jsonBody(t, do(h, "GET", "/git/"+pid+"/status", "", nil))["staged"].([]interface{})
	if len(staged) != 1 {
		t.Fatalf("expected staged entry, got: %s", w.Body.String())
	}
	entry := staged[0].(map[string]interface{})
	if entry["path"] != "b.txt" || entry["x"] == "" {
		t.Fatalf("staged entry missing x/y/path shape: %v", entry)
	}
	w = do(h, "POST", "/git/"+pid+"/commit", `{"message":"second"}`, nil)
	if w.Code != 200 {
		t.Fatalf("commit failed: %s", w.Body.String())
	}

	w = do(h, "GET", "/git/"+pid+"/log", "", nil)
	commits := jsonBody(t, w)["commits"].([]interface{})
	if len(commits) < 2 {
		t.Fatalf("log too short: %s", w.Body.String())
	}

	w = do(h, "GET", "/git/"+pid+"/graph", "", nil)
	graph := jsonBody(t, w)
	if _, ok := graph["branches"].(map[string]interface{}); !ok {
		t.Fatalf("graph missing branches object: %s", w.Body.String())
	}
	if gc := graph["commits"].([]interface{}); len(gc) < 2 {
		t.Fatalf("graph commits short: %s", w.Body.String())
	}

	// diff with per-file target
	w = do(h, "POST", "/git/"+pid+"/commit", `{"message":"noop-empty-fail"}`, nil)
	os.WriteFile(filepath.Join(repo, "a.txt"), []byte("changed\n"), 0644)
	w = do(h, "GET", "/git/"+pid+"/diff?file=a.txt", "", nil)
	d := jsonBody(t, w)["diff"].(string)
	if !strings.Contains(d, "a.txt") {
		t.Fatalf("per-file diff missing target: %q", d)
	}

	// branches create/checkout/delete
	do(h, "POST", "/git/"+pid+"/branch/create", `{"name":"dev"}`, nil)
	branches := jsonBody(t, do(h, "GET", "/git/"+pid+"/branches", "", nil))
	foundDev := false
	for _, b := range branches["all"].([]interface{}) {
		if b.(string) == "dev" {
			foundDev = true
		}
	}
	if !foundDev {
		t.Fatalf("branch dev not created: %v", branches["all"])
	}
	w = do(h, "POST", "/git/"+pid+"/checkout", `{"ref":"dev"}`, nil)
	if w.Code != 200 {
		t.Fatalf("checkout failed: %s", w.Body.String())
	}
	w = do(h, "POST", "/git/"+pid+"/checkout", `{"ref":"--orphan"}`, nil)
	if w.Code == 200 {
		t.Fatal("option injection accepted")
	}
	do(h, "POST", "/git/"+pid+"/branch/delete", `{"name":"dev","force":true}`, nil)

	// stash roundtrip
	os.WriteFile(filepath.Join(repo, "c.txt"), []byte("stashme\n"), 0644)
	do(h, "POST", "/git/"+pid+"/stash", `{"message":"wip"}`, nil)
	w = do(h, "GET", "/git/"+pid+"/stash", "", nil)
	stashes := jsonBody(t, w)["stashes"].([]interface{})
	if len(stashes) != 1 {
		t.Fatalf("stash list wrong: %s", w.Body.String())
	}
	if w.Code != 200 {
		t.Fatalf("stash drop failed: %s", w.Body.String())
	}
}

func TestFSTreeReadWriteContainment(t *testing.T) {
	tempCfg(t)
	repo := makeGitRepo(t)
	pid := registerProject(t, repo)
	h := http.HandlerFunc(handleFS)

	w := do(h, "POST", "/fs/"+pid+"/write", `{"path":"dir/f.txt","content":"hi"}`, nil)
	if w.Code != 200 {
		t.Fatalf("write failed: %s", w.Body.String())
	}
	w = do(h, "GET", "/fs/"+pid+"/read?path=dir/f.txt", "", nil)
	if jsonBody(t, w)["content"] != "hi" {
		t.Fatalf("read mismatch: %s", w.Body.String())
	}
	w = do(h, "GET", "/fs/"+pid+"/tree?path=.", "", nil)
	entries := jsonBody(t, w)["entries"].([]interface{})
	foundDir := false
	for _, e := range entries {
		em := e.(map[string]interface{})
		if em["name"] == "dir" && em["dir"] == true {
			foundDir = true
		}
	}
	if !foundDir {
		t.Fatalf("tree missing dir entry: %s", w.Body.String())
	}
	if w = do(h, "GET", "/fs/"+pid+"/read?path=../../../etc/passwd", "", nil); w.Code == 200 {
		t.Fatal("traversal read allowed")
	}
	if w = do(h, "POST", "/fs/"+pid+"/write", `{"path":"../outside.txt","content":"x"}`, nil); w.Code == 200 {
		t.Fatal("traversal write allowed")
	}
}

func TestTerminalExec(t *testing.T) {
	tempCfg(t)
	repo := makeGitRepo(t)
	registerProject(t, repo)
	h := http.HandlerFunc(handleTerminal)
	w := do(h, "POST", "/terminal/p1/exec", `{"command":"echo hello","timeout":10}`, nil)
	res := jsonBody(t, w)
	if strings.TrimRight(res["stdout"].(string), "\r\n") != "hello" {
		t.Fatalf("stdout wrong: %s", w.Body.String())
	}
}

func TestAuthMiddlewareTokenEnforcement(t *testing.T) {
	tempCfg(t)
	cfg.Token = "secret123"
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", handleHealth)
	mux.HandleFunc("/projects", handleProjects)
	handler := corsMiddleware(authMiddleware(mux))

	if w := do(handler, "GET", "/api/health", "", nil); w.Code != 200 {
		t.Fatal("health should stay open")
	}
	if w := do(handler, "GET", "/projects", "", nil); w.Code != 401 {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	if w := do(handler, "GET", "/projects", "", map[string]string{"Authorization": "Bearer secret123"}); w.Code != 200 {
		t.Fatalf("token rejected: %d", w.Code)
	}
	if w := do(handler, "GET", "/projects?token=secret123", "", nil); w.Code != 200 {
		t.Fatal("query token rejected")
	}
}

func TestFavoritesObjectFormatAndLegacyArray(t *testing.T) {
	tempCfg(t)
	favPath := filepath.Join(cfg.DataDir, "favorites.json")
	os.WriteFile(favPath, []byte(`["p/m"]`), 0644) // legacy bare array
	h := http.HandlerFunc(handleFavorites)
	if favs, ok := jsonBody(t, do(h, "GET", "/api/favorites", "", nil))["favorites"].([]interface{}); !ok || len(favs) != 1 {
		t.Fatalf("legacy array not readable")
	}
	w := do(h, "POST", "/api/favorites", `{"provider_id":"x","model_id":"y"}`, nil)
	added := jsonBody(t, w)
	if added["added"] != true {
		t.Fatalf("toggle failed: %s", added)
	}
	raw, _ := os.ReadFile(favPath)
	if !strings.Contains(string(raw), `"favorites"`) {
		t.Fatalf("favorites file not written in object format: %s", raw)
	}
}

func TestRegisterLocalMasksApiKeyInResponse(t *testing.T) {
	tempCfg(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir()) // redirect ~/.config
	home := t.TempDir()
	t.Setenv("USERPROFILE", home) // windows
	t.Setenv("HOME", home)        // unix

	body := `{"provider_id":"ollama","name":"Ollama","base_url":"http://127.0.0.1:11434/v1","models":[{"id":"m1","name":"M1"}],"api_key":"supersecret"}`
	respRec := do(http.HandlerFunc(handleRegisterLocal), "POST", "/api/models/register-local", body, nil)
	resp := jsonBody(t, respRec)
	out, _ := resp["config"].(map[string]interface{})["provider"].(map[string]interface{})["ollama"].(map[string]interface{})
	opts := out["options"].(map[string]interface{})
	if opts["apiKey"] == "supersecret" {
		t.Fatalf("API key leaked in response: %s", respRec.Body.String())
	}
	// But the real config on disk keeps the key.
	b, _ := os.ReadFile(opencodeConfigPath())
	if !strings.Contains(string(b), "supersecret") {
		t.Fatal("config lost real key")
	}
	probe := map[string]interface{}{}
	json.Unmarshal([]byte(`{"options":{"apiKey":"supersecret"}}`), &probe)
	t.Logf("direct deepCopyMasked: %#v", deepCopyMasked(probe))
}
