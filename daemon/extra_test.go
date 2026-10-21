package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// isolateHome points HOME/USERPROFILE/XDG at a temp dir so auth.json,
// opencode.json and ~/.git-credentials never touch the real user profile.
func isolateHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, ".local", "share"))
	return home
}

func needGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	setTestGitIdentity(t)
}

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := runGit(dir, args...)
	if err != nil {
		t.Fatalf("git %v: %v (%s)", args, err, out)
	}
	return out
}

// ------------------------------------------------------------------ auth ---

func TestNeedsAuth(t *testing.T) {
	cases := []struct {
		method, path string
		want         bool
	}{
		{"GET", "/api/health", false},
		{"GET", "/health", false},
		{"GET", "/api/auth/status", false},
		{"GET", "/api/projects", false},
		{"GET", "/projects", false},
		{"GET", "/api/models/global", false},
		{"GET", "/api/favorites", false},
		{"GET", "/api/settings/workspace", false},
		{"GET", "/api/fs/p/read", true},
		{"GET", "/fs/p/read", true},
		{"GET", "/git/p/status", true},
		{"POST", "/terminal/p/exec", true},
		{"GET", "/oc/p/session", true},
		// Public for GET but mutating methods must carry a token.
		{"POST", "/api/projects", true},
		{"POST", "/api/projects/import", true},
		{"POST", "/api/projects/clone", true},
		{"POST", "/api/favorites", true},
		{"POST", "/api/settings/workspace", true},
		{"POST", "/api/models/someproject", true},
		{"DELETE", "/api/models/someproject", true},
		{"POST", "/git/config", true},
		// Always protected regardless of method.
		{"GET", "/api/auth/token", true},
		{"POST", "/api/auth/token", true},
		{"GET", "/api/models/scan-lan", true},
		{"POST", "/api/models/probe-host", true},
		{"POST", "/api/models/register-local", true},
		// Health stays open for any method; non-API (static) paths are open.
		{"POST", "/api/health", false},
		{"GET", "/ui/", false},
		{"GET", "/", false},
	}
	for _, c := range cases {
		if got := needsAuth(c.method, c.path); got != c.want {
			t.Errorf("needsAuth(%s %s) = %v, want %v", c.method, c.path, got, c.want)
		}
	}
}

func TestCheckTokenAndBearer(t *testing.T) {
	tempCfg(t)
	cfg.Token = "s3cret-token"
	for tok, want := range map[string]bool{
		"s3cret-token":  true,
		"":              false,
		"s3cret-toke":   false,
		"s3cret-token2": false,
		"S3CRET-TOKEN":  false,
	} {
		if got := checkToken(tok); got != want {
			t.Errorf("checkToken(%q) = %v, want %v", tok, got, want)
		}
	}
	// Tokens longer than the 64 byte pad buffer must not be truncation-equal.
	cfg.Token = strings.Repeat("a", 80)
	if checkToken(strings.Repeat("a", 64)) {
		t.Error("prefix of a long token accepted")
	}
	if !checkToken(strings.Repeat("a", 80)) {
		t.Error("exact long token rejected")
	}

	r := httptest.NewRequest("GET", "/x?token=qq", nil)
	if bearerFromRequest(r) != "qq" {
		t.Error("query token not read")
	}
	r.Header.Set("Authorization", "Bearer  hdr ")
	if bearerFromRequest(r) != "hdr" {
		t.Errorf("header token = %q", bearerFromRequest(r))
	}
	r.Header.Set("Authorization", "Basic abc")
	if bearerFromRequest(r) != "qq" {
		t.Error("non-bearer scheme should fall back to query")
	}
}

func TestAuthMiddlewareProtectsMutationsAndFullMux(t *testing.T) {
	tempCfg(t)
	isolateHome(t)
	cfg.Token = "tok"
	mux := http.NewServeMux()
	mux.HandleFunc("/api/projects", handleProjects)
	mux.HandleFunc("/api/favorites", handleFavorites)
	mux.HandleFunc("/api/models/scan-lan", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	mux.HandleFunc("/api/fs/", handleFS)
	h := corsMiddleware(authMiddleware(mux))

	if w := do(h, "POST", "/api/projects", `{"name":"x","git_init":false}`, nil); w.Code != 401 {
		t.Fatalf("unauthenticated project create: %d", w.Code)
	}
	if w := do(h, "POST", "/api/favorites", `{"provider_id":"a","model_id":"b"}`, nil); w.Code != 401 {
		t.Fatalf("unauthenticated favorites write: %d", w.Code)
	}
	if w := do(h, "GET", "/api/models/scan-lan", "", nil); w.Code != 401 {
		t.Fatalf("scan-lan must be protected: %d", w.Code)
	}
	if w := do(h, "GET", "/api/favorites", "", nil); w.Code != 200 {
		t.Fatalf("favorites GET should stay open: %d", w.Code)
	}
	hdr := map[string]string{"Authorization": "Bearer tok"}
	if w := do(h, "POST", "/api/projects", `{"name":"x","git_init":false}`, hdr); w.Code != 200 {
		t.Fatalf("authenticated create failed: %d %s", w.Code, w.Body.String())
	}
	// Wrong token.
	if w := do(h, "GET", "/api/fs/x/tree", "", map[string]string{"Authorization": "Bearer nope"}); w.Code != 401 {
		t.Fatalf("bad token accepted: %d", w.Code)
	}
	// CORS preflight must never be blocked by auth and carries CORS headers.
	w := do(h, "OPTIONS", "/api/fs/x/tree", "", map[string]string{"Origin": "https://appassets.androidplatform.net"})
	if w.Code != 200 || w.Header().Get("Access-Control-Allow-Origin") != "https://appassets.androidplatform.net" {
		t.Fatalf("preflight broken: %d %v", w.Code, w.Header())
	}
	// 401 body is the FastAPI-compatible error shape.
	w = do(h, "GET", "/api/fs/x/tree", "", nil)
	body := jsonBody(t, w)
	if body["detail"] != "unauthorized" || body["ok"] != false {
		t.Fatalf("unexpected 401 body: %v", body)
	}
}

func TestNoTokenMeansNoAuth(t *testing.T) {
	tempCfg(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/anything", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	if w := do(authMiddleware(mux), "POST", "/api/anything", "", nil); w.Code != 204 {
		t.Fatalf("auth enforced with empty token: %d", w.Code)
	}
}

// ----------------------------------------------------------------- paths ---

func TestSafeJoinContainment(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "sub"), 0755)
	os.WriteFile(filepath.Join(root, "sub", "f.txt"), []byte("x"), 0644)

	good := []string{"", ".", "sub", "sub/f.txt", "sub/../sub/f.txt", "new/deep/file.txt", "/sub/f.txt"}
	for _, rel := range good {
		p, err := safeJoin(root, rel)
		if err != nil {
			t.Errorf("safeJoin(%q) rejected: %v", rel, err)
			continue
		}
		absRoot, _ := filepath.Abs(root)
		if !strings.HasPrefix(p, absRoot) {
			t.Errorf("safeJoin(%q) = %q outside root", rel, p)
		}
	}
	bad := []string{"..", "../x", "sub/../../x", "a/../../../etc/passwd"}
	for _, rel := range bad {
		if _, err := safeJoin(root, rel); err == nil {
			t.Errorf("safeJoin(%q) should have failed", rel)
		}
	}
	// A sibling directory sharing the root's name prefix is not "inside".
	sib := root + "-evil"
	os.MkdirAll(sib, 0755)
	defer os.RemoveAll(sib)
	if _, err := safeJoin(root, "../"+filepath.Base(sib)+"/x"); err == nil {
		t.Error("prefix-sibling escape allowed")
	}
}

func TestSafeJoinSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("s"), 0644)

	// Existing file through a symlinked directory.
	if _, err := safeJoin(root, "link/secret.txt"); err == nil {
		t.Error("read through symlink escape allowed")
	}
	// Write to a not-yet-existing file via symlink.
	if _, err := safeJoin(root, "link/new.txt"); err == nil {
		t.Error("write through symlink escape allowed")
	}
	// Deeper non-existent path under the symlink: previously fell back to the
	// lexical path and slipped through.
	if _, err := safeJoin(root, "link/newdir/deeper/new.txt"); err == nil {
		t.Error("deep write through symlink escape allowed")
	}
	// The link itself is inside root but resolves outside.
	if _, err := safeJoin(root, "link"); err == nil {
		t.Error("symlink pointing outside accepted")
	}
}

func TestSafeRefTable(t *testing.T) {
	ok := []string{"main", "feature/x-1", "v1.2.3", "origin/main", "a_b"}
	for _, s := range ok {
		if _, err := safeRef(s); err != nil {
			t.Errorf("safeRef(%q) rejected", s)
		}
	}
	bad := []string{"", " ", "-D", "--upload-pack=x", "a b", "a;b", "a$(x)", "a`b`", ".hidden", "/abs", "a\nb"}
	for _, s := range bad {
		if _, err := safeRef(s); err == nil {
			t.Errorf("safeRef(%q) accepted", s)
		}
	}
	if got, _ := safeRef("  main  "); got != "main" {
		t.Errorf("safeRef should trim, got %q", got)
	}
}

func TestResolveExistingOnMissingTail(t *testing.T) {
	root := t.TempDir()
	got := resolveExisting(filepath.Join(root, "a", "b", "c"))
	want := filepath.Join(resolveExisting(root), "a", "b", "c")
	if got != want {
		t.Errorf("resolveExisting = %q, want %q", got, want)
	}
}

// -------------------------------------------------------------- registry ---

func TestSlugifyAndUniqueSlug(t *testing.T) {
	for in, want := range map[string]string{
		"My App!":   "my-app",
		"  --a__b ": "a-b",
		"UPPER 42":  "upper-42",
		"!!!":       "",
		"":          "",
		"héllo":     "h-llo",
	} {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
	reg := Registry{Projects: []Project{{ID: "a"}, {ID: "a-2"}}}
	if got := uniqueSlug(reg, "a"); got != "a-3" {
		t.Errorf("uniqueSlug = %q", got)
	}
	if got := uniqueSlug(reg, "b"); got != "b" {
		t.Errorf("uniqueSlug = %q", got)
	}
}

func TestRegistryRoundTripAndCorruption(t *testing.T) {
	tempCfg(t)
	if reg := readRegistry(); reg.Projects == nil || len(reg.Projects) != 0 {
		t.Fatalf("empty registry should be non-nil empty slice: %#v", reg)
	}
	writeRegistry(Registry{Projects: []Project{{ID: "p", Name: "P", Path: "/x"}}})
	reg := readRegistry()
	if len(reg.Projects) != 1 || reg.Projects[0].ID != "p" {
		t.Fatalf("round trip failed: %#v", reg)
	}
	if findProject("p") == nil || findProject("nope") != nil {
		t.Fatal("findProject mismatch")
	}
	// No stray temp files left by the atomic writer.
	entries, _ := os.ReadDir(cfg.DataDir)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp") {
			t.Errorf("leftover temp file %s", e.Name())
		}
	}
	// Corrupt JSON degrades to an empty registry rather than panicking.
	os.WriteFile(getRegistryPath(), []byte("{not json"), 0644)
	if reg := readRegistry(); reg.Projects == nil || len(reg.Projects) != 0 {
		t.Fatalf("corrupt registry: %#v", reg)
	}
}

func TestUniqueProjectIDAvoidsExistingFolder(t *testing.T) {
	tempCfg(t)
	os.MkdirAll(filepath.Join(cfg.WorkspaceDir, "demo"), 0755)
	os.MkdirAll(filepath.Join(cfg.WorkspaceDir, "demo-2"), 0755)
	if got := uniqueProjectID(Registry{}, "demo"); got != "demo-3" {
		t.Errorf("uniqueProjectID = %q, want demo-3", got)
	}
	if got := uniqueProjectID(Registry{}, ""); !strings.HasPrefix(got, "project-") {
		t.Errorf("empty slug should fall back to project-N, got %q", got)
	}
}

func TestProjectCreateDoesNotMergeExistingFolder(t *testing.T) {
	tempCfg(t)
	existing := filepath.Join(cfg.WorkspaceDir, "keep")
	os.MkdirAll(existing, 0755)
	os.WriteFile(filepath.Join(existing, "precious.txt"), []byte("data"), 0644)
	w := do(http.HandlerFunc(handleProjects), "POST", "/api/projects", `{"name":"keep","git_init":false}`, nil)
	if w.Code != 200 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	if id := jsonBody(t, w)["id"]; id == "keep" {
		t.Fatal("new project reused an existing folder")
	}
	if _, err := os.Stat(filepath.Join(existing, "precious.txt")); err != nil {
		t.Fatal("pre-existing folder damaged")
	}
}

func TestProjectsMethodNotAllowed(t *testing.T) {
	tempCfg(t)
	if w := do(http.HandlerFunc(handleProjects), "PUT", "/api/projects", "", nil); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT -> %d", w.Code)
	}
	for _, h := range []http.HandlerFunc{handleProjectImport, handleProjectClone} {
		if w := do(h, "GET", "/api/projects/x", "", nil); w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("GET -> %d", w.Code)
		}
	}
}

func TestProjectImport(t *testing.T) {
	tempCfg(t)
	h := http.HandlerFunc(handleProjectImport)
	dir := t.TempDir()
	if w := do(h, "POST", "/api/projects/import", `{"path":""}`, nil); w.Code != 400 {
		t.Fatalf("empty path: %d", w.Code)
	}
	if w := do(h, "POST", "/api/projects/import", `{"path":`+jsonStr(filepath.Join(dir, "missing"))+`}`, nil); w.Code != 400 {
		t.Fatalf("missing dir: %d", w.Code)
	}
	w := do(h, "POST", "/api/projects/import", `{"path":`+jsonStr(dir)+`}`, nil)
	if w.Code != 200 {
		t.Fatalf("import: %d %s", w.Code, w.Body.String())
	}
	p := jsonBody(t, w)
	if p["id"] == "" || p["path"] == "" {
		t.Fatalf("bad import response: %v", p)
	}
	// Importing the same folder twice yields distinct ids.
	w2 := do(h, "POST", "/api/projects/import", `{"path":`+jsonStr(dir)+`}`, nil)
	if jsonBody(t, w2)["id"] == p["id"] {
		t.Fatal("duplicate import id")
	}
}

func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestProjectCloneValidation(t *testing.T) {
	tempCfg(t)
	h := http.HandlerFunc(handleProjectClone)
	for _, body := range []string{
		`{"url":""}`,
		`{"url":"--upload-pack=touch /tmp/pwned"}`,
		`{"url":"-c core.sshCommand=x"}`,
		`{"url":"ext::sh -c touch% /tmp/x"}`,
	} {
		if w := do(h, "POST", "/api/projects/clone", body, nil); w.Code != 400 {
			t.Errorf("clone %s -> %d, want 400", body, w.Code)
		}
	}
	if reg := readRegistry(); len(reg.Projects) != 0 {
		t.Fatalf("rejected clone registered a project: %#v", reg)
	}
}

func TestProjectCloneFromLocalRepo(t *testing.T) {
	tempCfg(t)
	needGit(t)
	src := makeGitRepo(t)
	w := do(http.HandlerFunc(handleProjectClone), "POST", "/api/projects/clone",
		`{"url":`+jsonStr(src)+`,"name":"cloned"}`, nil)
	if w.Code != 200 {
		t.Fatalf("clone: %d %s", w.Code, w.Body.String())
	}
	p := jsonBody(t, w)
	if _, err := os.Stat(filepath.Join(p["path"].(string), "a.txt")); err != nil {
		t.Fatalf("cloned file missing: %v", err)
	}
}

func TestFailedCloneDoesNotDeleteWorkspace(t *testing.T) {
	tempCfg(t)
	needGit(t)
	marker := filepath.Join(cfg.WorkspaceDir, "other", "keep.txt")
	os.MkdirAll(filepath.Dir(marker), 0755)
	os.WriteFile(marker, []byte("x"), 0644)
	// A URL whose base name slugifies to "" used to map the destination onto
	// the workspace root itself and RemoveAll it when git failed.
	w := do(http.HandlerFunc(handleProjectClone), "POST", "/api/projects/clone",
		`{"url":"/definitely/not/a/repo/..."}`, nil)
	if w.Code != 400 {
		t.Fatalf("clone of bad repo -> %d", w.Code)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("failed clone destroyed workspace contents")
	}
}

func TestProjectOpsGetStopDelete(t *testing.T) {
	tempCfg(t)
	ws := cfg.WorkspaceDir
	inside := filepath.Join(ws, "in")
	outside := t.TempDir()
	os.MkdirAll(inside, 0755)
	writeRegistry(Registry{Projects: []Project{
		{ID: "in", Name: "in", Path: inside},
		{ID: "out", Name: "out", Path: outside},
	}})
	h := http.HandlerFunc(handleProjectOps)

	if w := do(h, "GET", "/api/projects/in", "", nil); w.Code != 200 || jsonBody(t, w)["id"] != "in" {
		t.Fatalf("get: %d %s", w.Code, w.Body.String())
	}
	if w := do(h, "GET", "/api/projects/zzz", "", nil); w.Code != 404 {
		t.Fatalf("missing: %d", w.Code)
	}
	if w := do(h, "GET", "/api/projects/", "", nil); w.Code != 400 {
		t.Fatalf("empty id: %d", w.Code)
	}
	if w := do(h, "POST", "/api/projects/in/stop", "", nil); w.Code != 200 || jsonBody(t, w)["ok"] != false {
		t.Fatalf("stop of idle project: %d %s", w.Code, w.Body.String())
	}
	if w := do(h, "PUT", "/api/projects/in", "", nil); w.Code != 405 {
		t.Fatalf("PUT: %d", w.Code)
	}
	// delete_dir removes only folders inside the workspace.
	if w := do(h, "DELETE", "/api/projects/out?delete_dir=true", "", nil); w.Code != 200 {
		t.Fatalf("delete out: %d", w.Code)
	}
	if !statOK(outside) {
		t.Fatal("folder outside the workspace was deleted")
	}
	if w := do(h, "DELETE", "/api/projects/in?delete_dir=true", "", nil); w.Code != 200 {
		t.Fatalf("delete in: %d", w.Code)
	}
	if statOK(inside) {
		t.Fatal("workspace folder not removed with delete_dir=true")
	}
	if w := do(h, "DELETE", "/api/projects/in", "", nil); w.Code != 404 {
		t.Fatalf("double delete: %d", w.Code)
	}
}

// -------------------------------------------------------------------- FS ---

func TestFSErrorsAndEdgeCases(t *testing.T) {
	tempCfg(t)
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "d"), 0755)
	os.MkdirAll(filepath.Join(dir, "node_modules"), 0755)
	os.MkdirAll(filepath.Join(dir, ".git"), 0755)
	os.WriteFile(filepath.Join(dir, "d", "x.txt"), []byte("abc"), 0644)
	writeRegistry(Registry{Projects: []Project{{ID: "p", Name: "p", Path: dir}}})
	h := http.HandlerFunc(handleFS)

	if w := do(h, "GET", "/fs/missing/tree", "", nil); w.Code != 404 {
		t.Errorf("unknown project: %d", w.Code)
	}
	if w := do(h, "GET", "/fs/p", "", nil); w.Code != 400 {
		t.Errorf("missing op: %d", w.Code)
	}
	if w := do(h, "GET", "/fs/p/bogus", "", nil); w.Code != 404 {
		t.Errorf("unknown op: %d", w.Code)
	}
	if w := do(h, "GET", "/fs/p/read?path=nope.txt", "", nil); w.Code != 404 {
		t.Errorf("missing file: %d", w.Code)
	}
	// Reading a directory must not report success with empty content.
	if w := do(h, "GET", "/fs/p/read?path=d", "", nil); w.Code != 400 {
		t.Errorf("read dir: %d %s", w.Code, w.Body.String())
	}
	if w := do(h, "POST", "/fs/p/write", `{"content":"x"}`, nil); w.Code != 400 {
		t.Errorf("write without path: %d", w.Code)
	}
	if w := do(h, "GET", "/fs/p/write", "", nil); w.Code != 405 {
		t.Errorf("GET write: %d", w.Code)
	}
	if w := do(h, "POST", "/fs/p/write", `{"path":"/../../etc/x","content":"x"}`, nil); w.Code == 200 {
		// "/../../etc/x" is joined under root and cleaned, so it is contained
		// (not an escape); make sure it did not leave the project dir.
		if !statOK(filepath.Join(dir, "etc", "x")) {
			t.Error("absolute-looking path escaped the project")
		}
	}
	// A write to a directory path fails with 500, not a panic / success.
	if w := do(h, "POST", "/fs/p/write", `{"path":"d","content":"x"}`, nil); w.Code != 500 {
		t.Errorf("write onto dir: %d", w.Code)
	}
	// Oversized content is rejected with 413.
	big := `{"path":"big.txt","content":"` + strings.Repeat("a", 8<<20+1) + `"}`
	if w := do(h, "POST", "/fs/p/write", big, nil); w.Code != 413 && w.Code != 400 {
		t.Errorf("oversized write: %d", w.Code)
	}
	// tree hides .git / node_modules.
	w := do(h, "GET", "/fs/p/tree", "", nil)
	for _, e := range jsonBody(t, w)["entries"].([]interface{}) {
		n := e.(map[string]interface{})["name"]
		if n == ".git" || n == "node_modules" {
			t.Errorf("tree leaked %v", n)
		}
	}
	if w := do(h, "GET", "/fs/p/tree?path=../", "", nil); w.Code != 400 {
		t.Errorf("tree traversal: %d", w.Code)
	}
}

func TestFSWriteThroughSymlinkRejected(t *testing.T) {
	tempCfg(t)
	dir := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	writeRegistry(Registry{Projects: []Project{{ID: "p", Name: "p", Path: dir}}})
	h := http.HandlerFunc(handleFS)
	if w := do(h, "POST", "/fs/p/write", `{"path":"link/sub/evil.txt","content":"x"}`, nil); w.Code != 400 {
		t.Fatalf("symlink write -> %d", w.Code)
	}
	if statOK(filepath.Join(outside, "sub")) {
		t.Fatal("directory created outside the project through symlink")
	}
}

func TestBrowse(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "visible"), 0755)
	os.MkdirAll(filepath.Join(dir, ".hidden"), 0755)
	os.WriteFile(filepath.Join(dir, ".gitignore"), nil, 0644)
	w := do(http.HandlerFunc(handleBrowse), "GET", "/api/browse?path="+dir, "", nil)
	if w.Code != 200 {
		t.Fatalf("browse: %d", w.Code)
	}
	names := map[string]bool{}
	for _, e := range jsonBody(t, w)["entries"].([]interface{}) {
		names[e.(map[string]interface{})["name"].(string)] = true
	}
	if !names["visible"] || !names[".gitignore"] || names[".hidden"] {
		t.Fatalf("unexpected entries: %v", names)
	}
	if w := do(http.HandlerFunc(handleBrowse), "GET", "/api/browse?path="+filepath.Join(dir, "nope"), "", nil); w.Code != 500 {
		t.Fatalf("browse missing: %d", w.Code)
	}
}

// ------------------------------------------------------------------- Git ---

func TestBranchFromPorcelainAndStashRef(t *testing.T) {
	for in, want := range map[string]string{
		"## main...origin/main [ahead 1]": "main",
		"## feature/x":                    "feature/x",
		"## No commits yet on main":       "No commits yet on main",
		"":                                "",
		"M  a.txt":                        "",
	} {
		if got := branchFromPorcelain(in); got != want {
			t.Errorf("branchFromPorcelain(%q) = %q, want %q", in, got, want)
		}
	}
	if r, err := stashRef(3); err != nil || r != "stash@{3}" {
		t.Errorf("stashRef(3) = %q, %v", r, err)
	}
	if _, err := stashRef(-1); err == nil {
		t.Error("negative stash index accepted")
	}
}

func TestGitStatusStageUnstageGraph(t *testing.T) {
	tempCfg(t)
	needGit(t)
	repo := makeGitRepo(t)

	if st := gitStatusPayload(repo); st["clean"] != true || st["branch"] != "main" || st["is_git"] != true {
		t.Fatalf("fresh repo status: %v", st)
	}
	os.WriteFile(filepath.Join(repo, "a.txt"), []byte("changed\n"), 0644)
	os.WriteFile(filepath.Join(repo, "new.txt"), []byte("n\n"), 0644)
	os.WriteFile(filepath.Join(repo, "staged.txt"), []byte("s\n"), 0644)

	st := gitStatusPayload(repo)
	if st["clean"] != false || len(st["unstaged"].([]blob)) != 1 || len(st["untracked"].([]blob)) != 2 {
		t.Fatalf("dirty status: %v", st)
	}
	if err := stageFiles(repo, []string{"staged.txt"}); err != nil {
		t.Fatal(err)
	}
	st = gitStatusPayload(repo)
	staged := st["staged"].([]blob)
	if len(staged) != 1 || staged[0]["path"] != "staged.txt" {
		t.Fatalf("staged: %v", staged)
	}
	if err := unstageFiles(repo, []string{"staged.txt"}); err != nil {
		t.Fatal(err)
	}
	if len(gitStatusPayload(repo)["staged"].([]blob)) != 0 {
		t.Fatal("unstage failed")
	}
	if err := stageFiles(repo, nil); err != nil { // stage all
		t.Fatal(err)
	}
	if n := len(gitStatusPayload(repo)["staged"].([]blob)); n != 3 {
		t.Fatalf("stage all staged %d files", n)
	}
	if err := unstageFiles(repo, nil); err != nil {
		t.Fatal(err)
	}
	// Escaping paths are rejected before reaching git.
	if err := stageFiles(repo, []string{"../x"}); err == nil {
		t.Error("stage of escaping path allowed")
	}
	if err := unstageFiles(repo, []string{"../x"}); err == nil {
		t.Error("unstage of escaping path allowed")
	}

	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-m", "second")
	commits := graphCommits(repo, 10)
	if len(commits) != 2 || commits[0]["subject"] != "second" {
		t.Fatalf("graph: %v", commits)
	}
	if _, ok := commits[0]["parents"].([]string); !ok || len(commits[0]["parents"].([]string)) != 1 {
		t.Fatalf("parents: %v", commits[0]["parents"])
	}
	hasMain := false
	for _, r := range commits[0]["refs"].([]string) {
		if r == "main" {
			hasMain = true
		}
	}
	if !hasMain {
		t.Fatalf("refs missing main: %v", commits[0]["refs"])
	}
	if len(commits[1]["parents"].([]string)) != 0 {
		t.Fatalf("root commit should have empty parents: %v", commits[1]["parents"])
	}
}

func TestGitBranchesRemotesStashes(t *testing.T) {
	tempCfg(t)
	needGit(t)
	repo := makeGitRepo(t)
	gitIn(t, repo, "branch", "dev")
	b := branchesPayload(repo)
	if b["current"] != "main" || len(b["all"].([]string)) != 2 {
		t.Fatalf("branches: %v", b)
	}
	if got := remotesList(repo); len(got) != 0 {
		t.Fatalf("no remotes expected: %v", got)
	}
	gitIn(t, repo, "remote", "add", "origin", "https://example.com/r.git")
	got := remotesList(repo)
	if len(got) != 1 || got[0].Name != "origin" || got[0].Fetch != "https://example.com/r.git" || got[0].Push != "https://example.com/r.git" {
		t.Fatalf("remotes: %#v", got)
	}
	if len(stashesPayload(repo)) != 0 {
		t.Fatal("unexpected stashes")
	}
	os.WriteFile(filepath.Join(repo, "a.txt"), []byte("wip\n"), 0644)
	gitIn(t, repo, "stash", "push", "-m", "wip work")
	st := stashesPayload(repo)
	if len(st) != 1 || st[0]["index"] != 0 || !strings.Contains(st[0]["label"].(string), "wip work") {
		t.Fatalf("stashes: %v", st)
	}
}

func TestGitHandlerSafety(t *testing.T) {
	tempCfg(t)
	needGit(t)
	repo := makeGitRepo(t)
	pid := registerProject(t, repo)
	h := http.HandlerFunc(handleGit)
	base := "/git/" + pid + "/"

	// Dirty file that an empty-ref "discard" used to wipe along with everything.
	os.WriteFile(filepath.Join(repo, "a.txt"), []byte("precious edit\n"), 0644)
	for _, body := range []string{`{"ref":""}`, `{"ref":"."}`, `{}`} {
		if w := do(h, "POST", base+"discard", body, nil); w.Code != 400 {
			t.Errorf("discard %s -> %d, want 400", body, w.Code)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(repo, "a.txt")); string(b) != "precious edit\n" {
		t.Fatal("empty discard clobbered working tree")
	}
	if w := do(h, "POST", base+"resolve", `{"path":""}`, nil); w.Code != 400 {
		t.Errorf("resolve empty: %d", w.Code)
	}
	// Option injection through remote / ref names.
	for _, c := range []struct{ action, body string }{
		{"fetch", `{"name":"--upload-pack=touch pwned"}`},
		{"checkout", `{"ref":"-b"}`},
		{"merge", `{"ref":"--abort"}`},
		{"revert", `{"ref":"--quit"}`},
		{"branch", `{"name":"-D"}`},
		{"branch/delete", `{"name":"-D"}`},
		{"branch/rename", `{"old":"main","new":"--force"}`},
	} {
		if w := do(h, "POST", base+c.action, c.body, nil); w.Code != 400 {
			t.Errorf("%s %s -> %d, want 400", c.action, c.body, w.Code)
		}
	}
	if w := do(h, "POST", base+"stash/apply", `{"index":-1}`, nil); w.Code != 400 {
		t.Errorf("negative stash index: %d", w.Code)
	}
	if w := do(h, "GET", base+"diff?file=../../etc/passwd", "", nil); w.Code != 400 {
		t.Errorf("diff traversal: %d", w.Code)
	}
	if w := do(h, "POST", base+"nonsense", "", nil); w.Code != 404 {
		t.Errorf("unknown action: %d", w.Code)
	}
	if w := do(h, "POST", "/git/nope/status", "", nil); w.Code != 404 {
		t.Errorf("unknown project: %d", w.Code)
	}
	// Happy paths still work.
	if w := do(h, "POST", base+"branch", `{"name":"feature/x"}`, nil); w.Code != 200 {
		t.Errorf("create branch: %d %s", w.Code, w.Body.String())
	}
	if w := do(h, "POST", base+"discard", `{"ref":"a.txt"}`, nil); w.Code != 200 {
		t.Errorf("discard file: %d %s", w.Code, w.Body.String())
	}
	if b, _ := os.ReadFile(filepath.Join(repo, "a.txt")); strings.TrimSpace(string(b)) != "hello" {
		t.Errorf("discard did not restore file: %q", b)
	}
	w := do(h, "GET", base+"log?limit=5", "", nil)
	if commits := jsonBody(t, w)["commits"].([]interface{}); len(commits) != 1 {
		t.Errorf("log: %v", commits)
	}
	if w := do(h, "POST", base+"commit", `{"message":""}`, nil); w.Code != 400 {
		t.Errorf("empty commit message: %d", w.Code)
	}
}

func TestGitNonRepoResponses(t *testing.T) {
	tempCfg(t)
	dir := t.TempDir()
	pid := registerProject(t, dir)
	h := http.HandlerFunc(handleGit)
	w := do(h, "GET", "/git/"+pid+"/status", "", nil)
	if w.Code != 200 || jsonBody(t, w)["is_git"] != false {
		t.Fatalf("non-repo status: %s", w.Body.String())
	}
	w = do(h, "POST", "/git/"+pid+"/commit", `{"message":"x"}`, nil)
	if jsonBody(t, w)["ok"] != false {
		t.Fatalf("non-repo commit: %s", w.Body.String())
	}
}

func TestIsGitRepoAndHelpers(t *testing.T) {
	dir := t.TempDir()
	if isGitRepo(dir) {
		t.Fatal("empty dir is not a repo")
	}
	os.MkdirAll(filepath.Join(dir, ".git"), 0755)
	if !isGitRepo(dir) {
		t.Fatal(".git dir not detected")
	}
	wt := t.TempDir()
	os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: /x"), 0644)
	if !isGitRepo(wt) {
		t.Fatal("worktree .git file not detected")
	}
	if truncate("abcdef", 3) != "abc" || truncate("ab", 5) != "ab" {
		t.Error("truncate")
	}
	if shortOut("  ", "fb") != "fb" || shortOut(" x ", "fb") != "x" {
		t.Error("shortOut")
	}
	if len(shortOut(strings.Repeat("y", 900), "")) != 500 {
		t.Error("shortOut cap")
	}
	if orText("", "fb") != "fb" || orText("o", "fb") != "o" {
		t.Error("orText")
	}
	if minInt(1, 2) != 1 || minInt(5, 2) != 2 {
		t.Error("minInt")
	}
	if _, err := runGitOK(dir, "definitely-not-a-git-command"); err == nil {
		t.Error("runGitOK should surface errors")
	}
}

// --------------------------------------------------------------- terminal ---

func TestTerminalValidationAndExitCode(t *testing.T) {
	tempCfg(t)
	dir := t.TempDir()
	pid := registerProject(t, dir)
	h := http.HandlerFunc(handleTerminal)
	if w := do(h, "GET", "/terminal/"+pid+"/exec", "", nil); w.Code != 405 {
		t.Errorf("GET: %d", w.Code)
	}
	if w := do(h, "POST", "/terminal/"+pid+"/nope", `{"command":"echo"}`, nil); w.Code != 404 {
		t.Errorf("bad action: %d", w.Code)
	}
	if w := do(h, "POST", "/terminal/missing/exec", `{"command":"echo"}`, nil); w.Code != 404 {
		t.Errorf("missing project: %d", w.Code)
	}
	if w := do(h, "POST", "/terminal/"+pid+"/exec", `{"command":"  "}`, nil); w.Code != 400 {
		t.Errorf("blank command: %d", w.Code)
	}
	w := do(h, "POST", "/terminal/"+pid+"/exec", `{"command":"exit 3"}`, nil)
	res := jsonBody(t, w)
	if res["code"] != float64(3) || res["ok"] != false {
		t.Errorf("exit code: %v", res)
	}
}

func TestTerminalTimeoutKillsCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("relies on POSIX sleep")
	}
	tempCfg(t)
	pid := registerProject(t, t.TempDir())
	start := time.Now()
	w := do(http.HandlerFunc(handleTerminal), "POST", "/terminal/"+pid+"/exec",
		`{"command":"sleep 30","timeout":0.5}`, nil)
	if time.Since(start) > 10*time.Second {
		t.Fatalf("timeout not enforced, took %v", time.Since(start))
	}
	res := jsonBody(t, w)
	if res["code"] != float64(-1) || !strings.Contains(res["stderr"].(string), "timed out") {
		t.Fatalf("timeout result: %v", res)
	}
}

func TestCapBuffer(t *testing.T) {
	c := &capBuffer{max: 5}
	n, err := c.Write([]byte("abc"))
	if n != 3 || err != nil {
		t.Fatal(n, err)
	}
	n, _ = c.Write([]byte("defgh"))
	if n != 5 {
		t.Fatalf("Write must report full length to avoid short-write errors, got %d", n)
	}
	c.Write([]byte("zzz"))
	if c.String() != "abcde" {
		t.Fatalf("capBuffer = %q", c.String())
	}
}

// -------------------------------------------------- config / credentials ---

func TestMaskSecretAndDeepCopyMasked(t *testing.T) {
	if maskSecret("") != "" || maskSecret("short") != "****" || maskSecret("abcdefghijkl") != "abcd...ijkl" {
		t.Error("maskSecret")
	}
	in := map[string]interface{}{
		"provider": map[string]interface{}{
			"x": map[string]interface{}{"options": map[string]interface{}{"apiKey": "sk-supersecretvalue", "baseURL": "http://a"}},
			"y": map[string]interface{}{"options": map[string]interface{}{"apiKey": "local"}},
		},
		"list": []interface{}{map[string]interface{}{"apiKey": "sk-another-secret-key"}},
	}
	out, _ := json.Marshal(deepCopyMasked(in))
	if strings.Contains(string(out), "supersecretvalue") || strings.Contains(string(out), "another-secret") {
		t.Fatalf("secret leaked: %s", out)
	}
	if !strings.Contains(string(out), `"local"`) || !strings.Contains(string(out), "http://a") {
		t.Fatalf("non-secret values altered: %s", out)
	}
	// Original must not be mutated.
	orig, _ := json.Marshal(in)
	if !strings.Contains(string(orig), "supersecretvalue") {
		t.Fatal("deepCopyMasked mutated its input")
	}
}

func TestConfigHasSecrets(t *testing.T) {
	mk := func(k string) map[string]interface{} {
		return map[string]interface{}{"provider": map[string]interface{}{
			"p": map[string]interface{}{"options": map[string]interface{}{"apiKey": k}}}}
	}
	if configHasSecrets(map[string]interface{}{}) || configHasSecrets(mk("")) || configHasSecrets(mk("local")) {
		t.Error("false positive")
	}
	if !configHasSecrets(mk("sk-real")) {
		t.Error("false negative")
	}
}

func TestAuthJSONWriteReadAndMigration(t *testing.T) {
	tempCfg(t)
	isolateHome(t)
	// Legacy "token" shape for api entries is migrated to "key" on read.
	os.MkdirAll(filepath.Dir(authJSONPath()), 0o700)
	os.WriteFile(authJSONPath(), []byte(`{"opencode":{"type":"api","token":"legacy-tok"},"github":{"type":"token","token":"gh"}}`), 0644)
	d := readAuthJSON()
	oc := d["opencode"].(map[string]interface{})
	if oc["key"] != "legacy-tok" || oc["token"] != nil {
		t.Fatalf("migration failed: %v", oc)
	}
	if d["github"].(map[string]interface{})["token"] != "gh" {
		t.Fatal("non-api entries must be left alone")
	}
	if err := writeAuthJSON(d); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(authJSONPath())
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("auth.json mode %v, want 0600", fi.Mode().Perm())
		}
	}
	// Garbage file reads as empty, not nil.
	os.WriteFile(authJSONPath(), []byte("garbage"), 0600)
	if d := readAuthJSON(); d == nil || len(d) != 0 {
		t.Fatalf("garbage auth.json -> %v", d)
	}
}

func TestHandleAuthTokenSubscriptionAndProviderKey(t *testing.T) {
	tempCfg(t)
	isolateHome(t)
	h := http.HandlerFunc(handleAuthToken)

	w := do(h, "POST", "/api/auth/token", `{"provider_id":"opencode-go","token":"  go-token-123456  "}`, nil)
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	got := readAuthJSON()["opencode-go"].(map[string]interface{})
	if got["type"] != "api" || got["key"] != "go-token-123456" {
		t.Fatalf("auth entry: %v", got)
	}
	// Response must never echo the raw token.
	if strings.Contains(w.Body.String(), "go-token-123456") {
		t.Fatalf("token echoed in response: %s", w.Body.String())
	}
	// Clearing removes the entry.
	do(h, "POST", "/api/auth/token", `{"provider_id":"opencode-go","token":""}`, nil)
	if _, ok := readAuthJSON()["opencode-go"]; ok {
		t.Fatal("token not cleared")
	}

	// Newline injection into auth/credential files is refused.
	if w := do(h, "POST", "/api/auth/token", `{"provider_id":"github","token":"abc\nhttps://evil"}`, nil); w.Code != 400 {
		t.Fatalf("newline token: %d", w.Code)
	}

	// Generic provider keys land in opencode.json with restrictive perms.
	w = do(h, "POST", "/api/auth/token", `{"provider_id":"openai","token":"sk-openai-key-123","base_url":" http://x/v1 "}`, nil)
	if w.Code != 200 {
		t.Fatalf("provider key: %d %s", w.Code, w.Body.String())
	}
	if lookupProviderKey("openai") != "sk-openai-key-123" {
		t.Fatal("provider key not stored")
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(opencodeConfigPath())
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("opencode.json mode %v, want 0600", fi.Mode().Perm())
		}
	}
	cfgMap := readOpencodeConfig()
	opts := cfgMap["provider"].(map[string]interface{})["openai"].(map[string]interface{})["options"].(map[string]interface{})
	if opts["baseURL"] != "http://x/v1" {
		t.Fatalf("baseURL not trimmed: %v", opts["baseURL"])
	}
	// Status payload masks the key.
	st := authStatusPayload()
	if st["openai"].(blob)["configured"] != true || st["openai"].(blob)["preview"] == "sk-openai-key-123" {
		t.Fatalf("status: %v", st["openai"])
	}
}

func TestWriteOpencodeConfigTightensExistingPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permissions")
	}
	tempCfg(t)
	isolateHome(t)
	p := opencodeConfigPath()
	os.MkdirAll(filepath.Dir(p), 0755)
	os.WriteFile(p, []byte("{}"), 0644)
	if err := writeOpencodeConfig(map[string]interface{}{"k": "v"}, true); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(p)
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("existing world-readable config kept mode %v", fi.Mode().Perm())
	}
}

func TestSaveGitHubCredentialsMergesAndRemoves(t *testing.T) {
	needGit(t)
	home := isolateHome(t)
	cred := filepath.Join(home, ".git-credentials")
	os.WriteFile(cred, []byte("https://u:p@gitlab.com\nhttps://old:x@github.com\n"), 0600)
	saveGitHubCredentials("ghp_newtoken")
	b, _ := os.ReadFile(cred)
	s := string(b)
	if !strings.Contains(s, "gitlab.com") || strings.Contains(s, "old:x") || !strings.Contains(s, "ghp_newtoken@github.com") {
		t.Fatalf("credentials: %q", s)
	}
	saveGitHubCredentials("")
	b, _ = os.ReadFile(cred)
	if strings.Contains(string(b), "github.com") || !strings.Contains(string(b), "gitlab.com") {
		t.Fatalf("after removal: %q", b)
	}
}

func TestSubscriptionTokenAndCloudEndpoint(t *testing.T) {
	t.Setenv("OPENCODE_API_KEY", "envkey")
	if subscriptionToken(map[string]interface{}{}, "opencode-go") != "envkey" {
		t.Error("env fallback")
	}
	if subscriptionToken(map[string]interface{}{}, "opencode") != "" {
		t.Error("zen has no env fallback")
	}
	d := map[string]interface{}{"opencode": map[string]interface{}{"token": "legacy"}}
	if subscriptionToken(d, "opencode") != "legacy" {
		t.Error("legacy token field")
	}
	d = map[string]interface{}{"opencode": map[string]interface{}{"key": "k", "token": "legacy"}}
	if subscriptionToken(d, "opencode") != "k" {
		t.Error("key must win over token")
	}
	for id, sub := range map[string]string{
		"opencode-go": "/zen/go/", "google": "googleapis", "gemini": "googleapis", "opencode": "/zen/v1/",
	} {
		if !strings.Contains(cloudEndpoint(id), sub) {
			t.Errorf("cloudEndpoint(%s) = %s", id, cloudEndpoint(id))
		}
	}
	if !strings.Contains(executeAICall("opencode", "", "m", "hi"), "API Key Not Set") {
		t.Error("missing token message")
	}
}

func TestFavoritesToggleAndConcurrency(t *testing.T) {
	tempCfg(t)
	h := http.HandlerFunc(handleFavorites)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			do(h, "POST", "/api/favorites", `{"provider_id":"p","model_id":"m`+string(rune('a'+i))+`"}`, nil)
		}(i)
	}
	wg.Wait()
	favs := jsonBody(t, do(h, "GET", "/api/favorites", "", nil))["favorites"].([]interface{})
	if len(favs) != 20 {
		t.Fatalf("lost updates under concurrency: %d/20", len(favs))
	}
	// Toggling again removes.
	w := do(h, "POST", "/api/favorites", `{"provider_id":"p","model_id":"ma"}`, nil)
	if jsonBody(t, w)["added"] != false {
		t.Fatal("toggle off failed")
	}
	if w := do(h, "PUT", "/api/favorites", "", nil); w.Code != 405 {
		t.Fatalf("PUT: %d", w.Code)
	}
}

func TestModelsWriteAndDelete(t *testing.T) {
	tempCfg(t)
	isolateHome(t)
	if w := do(http.HandlerFunc(handleModelsWrite), "POST", "/api/models/x", `{"provider_id":"p"}`, nil); w.Code != 400 {
		t.Fatalf("missing model_id: %d", w.Code)
	}
	w := do(http.HandlerFunc(handleModelsWrite), "POST", "/api/models/x",
		`{"provider_id":"p","model_id":"m","options":{"temperature":0.2,"skip":null},"set_default":true}`, nil)
	if w.Code != 200 {
		t.Fatalf("write: %d %s", w.Code, w.Body.String())
	}
	c := readOpencodeConfig()
	if c["model"] != "p/m" {
		t.Fatalf("default not set: %v", c["model"])
	}
	m := c["provider"].(map[string]interface{})["p"].(map[string]interface{})["models"].(map[string]interface{})["m"].(map[string]interface{})
	if m["temperature"] != 0.2 {
		t.Fatalf("options: %v", m)
	}
	if _, has := m["skip"]; has {
		t.Fatal("null option stored")
	}
	if w := do(http.HandlerFunc(handleModelsDelete), "DELETE", "/api/models/x", `{"provider_id":"p","model_id":"m"}`, nil); w.Code != 200 {
		t.Fatalf("delete: %d", w.Code)
	}
	c = readOpencodeConfig()
	if _, has := c["model"]; has {
		t.Fatal("default not cleared on delete")
	}
	if _, has := c["provider"].(map[string]interface{})["p"].(map[string]interface{})["models"].(map[string]interface{})["m"]; has {
		t.Fatal("model not deleted")
	}
}

func TestSettingsWorkspace(t *testing.T) {
	tempCfg(t)
	h := http.HandlerFunc(handleSettingsWorkspace)
	if got := jsonBody(t, do(h, "GET", "/api/settings/workspace", "", nil))["workspace_dir"]; got != cfg.WorkspaceDir {
		t.Fatalf("default: %v", got)
	}
	if w := do(h, "POST", "/api/settings/workspace", `{"path":""}`, nil); w.Code != 400 {
		t.Fatalf("empty: %d", w.Code)
	}
	np := filepath.Join(t.TempDir(), "newws")
	if w := do(h, "POST", "/api/settings/workspace", `{"path":`+jsonStr(np)+`}`, nil); w.Code != 200 {
		t.Fatalf("set: %d", w.Code)
	}
	if !statOK(np) || getWorkspaceDir() != np {
		t.Fatal("workspace not applied")
	}
	if w := do(h, "DELETE", "/api/settings/workspace", "", nil); w.Code != 405 {
		t.Fatalf("DELETE: %d", w.Code)
	}
}

// ------------------------------------------------------------- AI scanning ---

func TestScanHostPortParsesOllamaAndOpenAI(t *testing.T) {
	ollama := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tags" {
			http.NotFound(w, r)
			return
		}
		io.WriteString(w, `{"models":[{"name":"llama3"},{"name":"qwen"}]}`)
	}))
	defer ollama.Close()
	host, port := hostPort(t, ollama)
	srv := scanHostPort(ollama.Client(), host, port)
	if srv == nil || srv.Type != "ollama" || len(srv.Models) != 2 || srv.Models[0].ID != "llama3" {
		t.Fatalf("ollama scan: %#v", srv)
	}
	if !strings.HasSuffix(srv.BaseURL, "/v1") {
		t.Fatalf("base url: %s", srv.BaseURL)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", 500)
	}))
	defer bad.Close()
	h2, p2 := hostPort(t, bad)
	if scanHostPort(bad.Client(), h2, p2) != nil {
		t.Fatal("500 should not be reported as a server")
	}
	junk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "not json") }))
	defer junk.Close()
	h3, p3 := hostPort(t, junk)
	if scanHostPort(junk.Client(), h3, p3) != nil {
		t.Fatal("non-JSON should be ignored")
	}
}

func hostPort(t *testing.T, s *httptest.Server) (string, int) {
	t.Helper()
	return "127.0.0.1", srvPort(t, s)
}

func TestProbeHostValidation(t *testing.T) {
	tempCfg(t)
	h := http.HandlerFunc(handleProbeHost)
	if w := do(h, "POST", "/api/models/probe-host", `{"host":"  "}`, nil); w.Code != 400 {
		t.Fatalf("empty host: %d", w.Code)
	}
	// Closed port on loopback -> 404 unreachable.
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	body, _ := json.Marshal(map[string]interface{}{"host": "127.0.0.1", "port": port})
	if w := do(h, "POST", "/api/models/probe-host", string(body), nil); w.Code != 404 {
		t.Fatalf("unreachable: %d", w.Code)
	}
}

func TestIsPortHealthy(t *testing.T) {
	status := 200
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/global/health" {
			w.WriteHeader(status)
		}
	}))
	defer srv.Close()
	port := srvPort(t, srv)
	if !isPortHealthy(port) {
		t.Fatal("200 should be healthy")
	}
	status = 503
	if isPortHealthy(port) {
		t.Fatal("503 should be unhealthy")
	}
	srv.Close()
	if isPortHealthy(port) {
		t.Fatal("closed port healthy")
	}
}

// ------------------------------------------------------------ OC / health ---

func TestOpenCodeStandaloneSessions(t *testing.T) {
	tempCfg(t)
	h := http.HandlerFunc(handleOpenCode)
	if w := do(h, "GET", "/oc/", "", nil); w.Code != 400 {
		t.Fatalf("missing pid: %d", w.Code)
	}
	// Ids end up in file names under the data dir: reject path-ish ones.
	for _, p := range []string{"/oc/..%5Cevil/session", "/oc/ok/session/..%5Cx/message"} {
		if w := do(h, "GET", p, "", nil); w.Code != 400 {
			t.Errorf("%s -> %d, want 400", p, w.Code)
		}
	}

	w := do(h, "POST", "/oc/demo/session", "", nil)
	if w.Code != 200 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	sid := jsonBody(t, w)["id"].(string)
	var list []map[string]interface{}
	json.Unmarshal(do(h, "GET", "/oc/demo/session", "", nil).Body.Bytes(), &list)
	if len(list) != 1 || list[0]["id"] != sid {
		t.Fatalf("list: %v", list)
	}
	if w := do(h, "PATCH", "/oc/demo/session/"+sid, `{"title":"Renamed"}`, nil); w.Code != 200 {
		t.Fatalf("patch: %d", w.Code)
	}
	if w := do(h, "PATCH", "/oc/demo/session/ses_missing", `{"title":"x"}`, nil); w.Code != 404 {
		t.Fatalf("patch missing: %d", w.Code)
	}
	// Previously indexed parts[3] on a 3-element path and panicked.
	if w := do(h, "GET", "/oc/demo/session/"+sid, "", nil); w.Code != 503 {
		t.Fatalf("GET session (no engine): %d", w.Code)
	}
	if w := do(h, "POST", "/oc/demo/session/"+sid+"/abort", "", nil); w.Code != 503 {
		t.Fatalf("abort: %d", w.Code)
	}
	if w := do(h, "GET", "/oc/demo/session/"+sid+"/message", "", nil); w.Code != 200 {
		t.Fatalf("messages: %d", w.Code)
	}
	if w := do(h, "DELETE", "/oc/demo/session/"+sid, "", nil); w.Code != 200 {
		t.Fatalf("delete: %d", w.Code)
	}
	list = nil
	json.Unmarshal(do(h, "GET", "/oc/demo/session", "", nil).Body.Bytes(), &list)
	if len(list) != 0 {
		t.Fatalf("session not deleted: %v", list)
	}
	if w := do(h, "GET", "/oc/demo/unknown", "", nil); w.Code != 503 {
		t.Fatalf("no engine fallthrough: %d", w.Code)
	}
}

func TestRunStandaloneCompletionToleratesMissingTimeMap(t *testing.T) {
	tempCfg(t)
	isolateHome(t)
	t.Setenv("OPENCODE_API_KEY", "")
	saveMessages("p", "s", []SessionMsg{{Info: MsgInfo{ID: "a1", Role: "assistant"}}}) // Time == nil
	runStandaloneCompletion("p", "s", "a1", "opencode", "m", "hello")                  // no token -> offline message
	msgs := loadMessages("p", "s")
	if len(msgs) != 1 || len(msgs[0].Parts) != 1 || !strings.Contains(msgs[0].Parts[0].Text, "API Key Not Set") {
		t.Fatalf("completion not stored: %#v", msgs)
	}
	if msgs[0].Info.Time["completed"] == nil {
		t.Fatal("completed time missing")
	}
}

func TestOpenCodeProxyForwardsAndStripsCredentials(t *testing.T) {
	tempCfg(t)
	cfg.Token = "daemon-token"
	var gotPath, gotAuth, gotQuery string
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/global/health" {
			w.WriteHeader(200)
			return
		}
		gotPath, gotAuth, gotQuery = r.URL.Path, r.Header.Get("Authorization"), r.URL.RawQuery
		io.WriteString(w, `{"proxied":true}`)
	}))
	defer engine.Close()
	// Pre-register a "running" instance whose process is this test process's
	// stand-in; acquire() trusts Cmd.Process + health.
	cmd := exec.Command(os.Args[0], "-test.run=NONE")
	if err := cmd.Start(); err != nil {
		t.Skip("cannot spawn helper process")
	}
	defer cmd.Process.Kill()
	inst := &Instance{PID: "proj", Port: srvPort(t, engine), Cmd: cmd, LastUsed: time.Now(), Started: time.Now(), exited: make(chan struct{})}
	instMgr.instances["proj"] = inst

	h := authMiddleware(http.HandlerFunc(handleOpenCode))
	w := do(h, "GET", "/oc/proj/session?limit=2&token=daemon-token", "", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "proxied") {
		t.Fatalf("proxy: %d %s", w.Code, w.Body.String())
	}
	if gotPath != "/session" || gotAuth != "" || strings.Contains(gotQuery, "token") || !strings.Contains(gotQuery, "limit=2") {
		t.Fatalf("engine saw path=%q auth=%q query=%q", gotPath, gotAuth, gotQuery)
	}
}

func TestManagerGetUnknownProject(t *testing.T) {
	tempCfg(t)
	if _, err := instMgr.Get("ghost"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected not found, got %v", err)
	}
	if instMgr.Stop("ghost") {
		t.Fatal("Stop of unknown instance reported true")
	}
	instMgr.StopAll() // must not panic on empty set
}

func TestManagerStopKillsProcess(t *testing.T) {
	tempCfg(t)
	cmd := exec.Command(os.Args[0], "-test.run=NONE")
	if err := cmd.Start(); err != nil {
		t.Skip("cannot spawn helper process")
	}
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	instMgr.instances["x"] = &Instance{PID: "x", Cmd: cmd, exited: exited}
	if !instMgr.Stop("x") {
		t.Fatal("Stop returned false")
	}
	if len(instMgr.instances) != 0 {
		t.Fatal("instance still registered")
	}
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("process not terminated")
	}
}

func TestHealthEndpoint(t *testing.T) {
	tempCfg(t)
	cfg.Version = "9.9.9"
	cfg.Token = "x"
	cfg.OpenCodeBin = filepath.Join(t.TempDir(), "missing")
	t.Setenv("PATH", "")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", os.Getenv("HOME"))
	w := do(http.HandlerFunc(handleHealth), "GET", "/api/health", "", nil)
	b := jsonBody(t, w)
	if w.Code != 200 || b["bridge"] != "ok" || b["daemon_version"] != "9.9.9" || b["auth"] != true {
		t.Fatalf("health: %s", w.Body.String())
	}
	if b["opencode"].(map[string]interface{})["local"] != false {
		t.Fatalf("engine should be absent: %v", b["opencode"])
	}
}

func TestEngineVersionReportsAndCachesFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs an executable script")
	}
	tempCfg(t)
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin", "opencode")
	os.MkdirAll(filepath.Dir(bin), 0755)
	os.WriteFile(bin, []byte("#!/bin/sh\necho 1.2.3\n"), 0755)
	verCachePth = ""
	v, e := engineVersion(bin)
	if v != "1.2.3" || e != "" {
		t.Fatalf("version = %q err = %q", v, e)
	}
	// Second call within the TTL is served from cache even if the file is gone.
	os.Remove(bin)
	if v2, _ := engineVersion(bin); v2 != "1.2.3" {
		t.Fatalf("cache miss: %q", v2)
	}
	verCachePth = ""
	if _, e := engineVersion(bin); e == "" {
		t.Fatal("expected an error for a missing engine")
	}
}

func TestWriteFileAtomicOverwrites(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f.json")
	for _, c := range []string{"one", "two-longer-content", "x"} {
		if err := writeFileAtomic(p, []byte(c), 0600); err != nil {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(p); string(b) != c {
			t.Fatalf("got %q want %q", b, c)
		}
	}
	if err := writeFileAtomic(filepath.Join(t.TempDir(), "no", "such", "dir", "f"), []byte("x"), 0600); err == nil {
		t.Fatal("expected error for missing directory")
	}
}

func TestWriteHelpers(t *testing.T) {
	w := httptest.NewRecorder()
	writeErr(w, 418, "teapot")
	b := jsonBody(t, w)
	if w.Code != 418 || b["detail"] != "teapot" || b["error"] != "teapot" || b["ok"] != false {
		t.Fatalf("writeErr: %v", b)
	}
	w = httptest.NewRecorder()
	writeOut(w, "out", nil)
	if jsonBody(t, w)["out"] != "out" || w.Code != 200 {
		t.Fatal("writeOut ok")
	}
	w = httptest.NewRecorder()
	writeOut(w, "partial", io.ErrUnexpectedEOF)
	if w.Code != 400 || !strings.Contains(jsonBody(t, w)["detail"].(string), "partial") {
		t.Fatal("writeOut err")
	}
	// decodeBody tolerates empty and malformed bodies without panicking.
	var v struct{ A string }
	decodeBody(httptest.NewRequest("POST", "/", strings.NewReader("")), &v)
	decodeBody(httptest.NewRequest("POST", "/", strings.NewReader("{bad")), &v)
	decodeBody(httptest.NewRequest("POST", "/", strings.NewReader(`{"A":"z"}`)), &v)
	if v.A != "z" {
		t.Fatal("decodeBody")
	}
}

func TestNormalizeEngineProvidersSkipsGarbage(t *testing.T) {
	got := normalizeEngineProviders(map[string]interface{}{"providers": []interface{}{
		"string", 5, map[string]interface{}{}, map[string]interface{}{"name": "OnlyName"},
		map[string]interface{}{"id": "x", "models": []interface{}{"bad", map[string]interface{}{"name": "noid"}}},
	}})
	if len(got) != 2 || got[0].ID != "OnlyName" || got[1].ID != "x" || len(got[1].Models) != 0 {
		t.Fatalf("unexpected: %#v", got)
	}
	if normalizeEngineProviders(nil) == nil {
		t.Fatal("must return non-nil slice")
	}
}

// -------------------------------------------------------------- dnsproxy ---

func TestEngineProxyEnv(t *testing.T) {
	oldStarted, oldAddr := proxy.started, proxy.addr
	defer func() { proxy.started, proxy.addr = oldStarted, oldAddr }()
	proxy.started = false
	if engineProxyEnv() != nil {
		t.Fatal("env must be nil when proxy is not running")
	}
	proxy.started, proxy.addr = true, "127.0.0.1:8791"
	env := strings.Join(engineProxyEnv(), "\n")
	for _, want := range []string{"HTTP_PROXY=127.0.0.1:8791", "HTTPS_PROXY=127.0.0.1:8791", "NO_PROXY=127.0.0.1,localhost,::1"} {
		if !strings.Contains(env, want) {
			t.Errorf("missing %s in %s", want, env)
		}
	}
}

func TestSystemNameserverIsHostPort(t *testing.T) {
	ns := systemNameserver()
	host, port, err := net.SplitHostPort(ns)
	if err != nil || port != "53" || net.ParseIP(host) == nil {
		t.Fatalf("nameserver %q is not ip:53", ns)
	}
}

func newTestProxy() *dnsProxy {
	return &dnsProxy{
		dialer:   &net.Dialer{Timeout: 2 * time.Second},
		resolver: &net.Resolver{PreferGo: true},
	}
}

func TestDialResolvedLiteralIPAndErrors(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			c.Close()
		}
	}()
	p := newTestProxy()
	c, err := p.dialResolved(context.Background(), ln.Addr().String())
	if err != nil {
		t.Fatalf("dial literal IP: %v", err)
	}
	c.Close()
	if _, err := p.dialResolved(context.Background(), "no-port-here"); err == nil {
		t.Error("missing port must error")
	}
}

func TestProxyConnectTunnelsDataAndBufferedBytes(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()

	p := newTestProxy()
	ps := httptest.NewServer(http.HandlerFunc(p.handle))
	defer ps.Close()

	conn, err := net.Dial("tcp", ps.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	target := echo.Addr().String()
	// "early" is sent in the same segment as the CONNECT request, so the
	// server's bufio reader already holds it when the tunnel starts.
	io.WriteString(conn, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\n\r\nearly")
	br := bufio.NewReader(conn)
	status, err := br.ReadString('\n')
	if err != nil || !strings.Contains(status, "200") {
		t.Fatalf("status %q err %v", status, err)
	}
	for { // drain headers
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(br, buf); err != nil || string(buf) != "early" {
		t.Fatalf("early bytes lost: %q %v", buf, err)
	}
	io.WriteString(conn, "ping")
	buf = make([]byte, 4)
	if _, err := io.ReadFull(br, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("echo: %q %v", buf, err)
	}
}

func TestProxyConnectBadGateway(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	p := newTestProxy()
	req := httptest.NewRequest(http.MethodConnect, "http://"+addr, nil)
	req.Host = addr
	w := httptest.NewRecorder()
	p.handle(w, req)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("closed target -> %d", w.Code)
	}
	req = httptest.NewRequest(http.MethodConnect, "http://x", nil)
	req.Host = ""
	w = httptest.NewRecorder()
	p.handle(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty host -> %d", w.Code)
	}
}

func TestProxyForwardsPlainHTTP(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Seen-Proxy-Connection", r.Header.Get("Proxy-Connection"))
		io.WriteString(w, "origin:"+r.URL.Path)
	}))
	defer origin.Close()
	p := newTestProxy()
	ps := httptest.NewServer(http.HandlerFunc(p.handle))
	defer ps.Close()
	pu, _ := url.Parse(ps.URL)
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(pu)}, Timeout: 5 * time.Second}
	req, _ := http.NewRequest("GET", origin.URL+"/hello", nil)
	req.Header.Set("Proxy-Connection", "keep-alive")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if string(b) != "origin:/hello" {
		t.Fatalf("body %q", b)
	}
	if resp.Header.Get("X-Seen-Proxy-Connection") != "" {
		t.Error("Proxy-Connection hop-by-hop header leaked to origin")
	}
}
