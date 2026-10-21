package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAllowedOrigin(t *testing.T) {
	for origin, want := range map[string]bool{
		"https://appassets.androidplatform.net":         true,
		"http://127.0.0.1:8787":                         true,
		"http://localhost:8787":                         true,
		"http://[::1]:8787":                             true,
		"https://evil.com":                              false,
		"http://appassets.androidplatform.net":          false,
		"https://appassets.androidplatform.net.evil.io": false,
		"http://127.0.0.1.nip.io":                       false,
		"null":                                          false,
		"":                                              false,
	} {
		if got := allowedOrigin(origin); got != want {
			t.Errorf("allowedOrigin(%q) = %v, want %v", origin, got, want)
		}
	}
}

func TestCORSOnlyEchoesTrustedOrigins(t *testing.T) {
	h := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	w := do(h, "GET", "/api/projects", "", map[string]string{"Origin": "https://evil.com"})
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("evil origin got ACAO %q", got)
	}
	w = do(h, "OPTIONS", "/api/projects", "", map[string]string{"Origin": "https://appassets.androidplatform.net"})
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://appassets.androidplatform.net" {
		t.Fatalf("asset origin ACAO = %q", got)
	}
	if w.Code != 200 || w.Header().Get("Vary") != "Origin" {
		t.Fatalf("preflight: code=%d vary=%q", w.Code, w.Header().Get("Vary"))
	}
}

func TestHostGuardBlocksRebinding(t *testing.T) {
	tempCfg(t)
	h := hostGuardMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(204)
	}))
	serve := func(host string) int {
		req := httptest.NewRequest("GET", "/api/browse", nil)
		req.Host = host
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w.Code
	}
	for _, host := range []string{"127.0.0.1:8787", "localhost:8787", "[::1]:8787", "127.0.0.1"} {
		if c := serve(host); c != 204 {
			t.Errorf("host %q -> %d, want 204", host, c)
		}
	}
	for _, host := range []string{"evil.com:8787", "rebind.example", "127.0.0.1.nip.io:8787"} {
		if c := serve(host); c != 403 {
			t.Errorf("host %q -> %d, want 403", host, c)
		}
	}
	// Bound to a LAN/Tailscale address: any Host is fine (token auth applies).
	cfg.Host = "0.0.0.0"
	if c := serve("phone.tailnet.ts.net:8787"); c != 204 {
		t.Errorf("non-loopback bind blocked host: %d", c)
	}
}

func TestSafeGitURL(t *testing.T) {
	for u, want := range map[string]bool{
		"https://github.com/a/b.git":     true,
		"git@github.com:a/b.git":         true,
		"/local/path/repo":               true,
		"":                               false,
		"--upload-pack=touch /tmp/pwned": false,
		"ext::sh -c touch% /tmp/pwned":   false,
		"EXT::sh":                        false,
		"https://x/\nrepo":               false,
	} {
		if got := safeGitURL(u); got != want {
			t.Errorf("safeGitURL(%q) = %v, want %v", u, got, want)
		}
	}
}

func TestGitRemoteAddSetURLRemove(t *testing.T) {
	tempCfg(t)
	needGit(t)
	repo := makeGitRepo(t)
	pid := registerProject(t, repo)
	h := http.HandlerFunc(handleGit)
	base := "/git/" + pid + "/remote/"

	if w := do(h, "POST", base+"add", `{"name":"origin","url":"https://example.com/a.git"}`, nil); w.Code != 200 {
		t.Fatalf("add: %d %s", w.Code, w.Body.String())
	}
	if w := do(h, "POST", base+"set-url", `{"name":"origin","url":"https://example.com/b.git"}`, nil); w.Code != 200 {
		t.Fatalf("set-url: %d %s", w.Code, w.Body.String())
	}
	rs := remotesList(repo)
	if len(rs) != 1 || rs[0].Fetch != "https://example.com/b.git" {
		t.Fatalf("remotes after set-url: %#v", rs)
	}
	for _, body := range []string{
		`{"name":"--evil","url":"https://example.com/c.git"}`,
		`{"name":"up","url":"ext::sh -c id"}`,
		`{"name":"up","url":"--upload-pack=id"}`,
		`{"name":"","url":"https://example.com/c.git"}`,
	} {
		if w := do(h, "POST", base+"add", body, nil); w.Code != 400 {
			t.Errorf("add %s -> %d, want 400", body, w.Code)
		}
	}
	if w := do(h, "POST", base+"bogus", `{"name":"origin"}`, nil); w.Code != 404 {
		t.Errorf("unknown remote action -> %d", w.Code)
	}
	if w := do(h, "POST", base+"remove", `{"name":"origin"}`, nil); w.Code != 200 {
		t.Fatalf("remove: %d %s", w.Code, w.Body.String())
	}
	if rs := remotesList(repo); len(rs) != 0 {
		t.Fatalf("remote not removed: %#v", rs)
	}
}
