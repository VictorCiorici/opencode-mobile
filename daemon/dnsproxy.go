package main

// dnsProxy provides engine-side HTTPS connectivity on Android. The engine is
// a musl binary: musl (and c-ares inside Bun) resolve hostnames from
// /etc/resolv.conf, which does not exist on Android (bionic goes through
// netd instead) — every hostname lookup fails and Bun reports "Cannot
// connect to API". Binding a resolver on 127.0.0.1:53 is not an option for
// an app uid (privileged port), so instead the daemon runs a local HTTP
// CONNECT proxy that resolves names itself — via plain UDP queries to a
// nameserver by IP (no resolv.conf needed) — and the engine is given
// HTTP(S)_PROXY pointing at it.

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

type dnsProxy struct {
	addr      string
	namesrv   string
	resolver  *net.Resolver
	dialer    *net.Dialer
	startOnce sync.Once
	started   bool
}

var proxy = &dnsProxy{}

// startDNSProxy begins listening on 127.0.0.1:<port>. Failure is logged but
// non-fatal: engines simply spawn without proxy env (fine on desktop/dev).
func startDNSProxy(port int) {
	proxy.startOnce.Do(func() {
		proxy.namesrv = systemNameserver()
		ns := proxy.namesrv
		proxy.resolver = &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, network, ns)
			},
		}
		proxy.dialer = &net.Dialer{Timeout: 15 * time.Second}
		addr := "127.0.0.1:" + strconv.Itoa(port)
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			log.Printf("dns-proxy: not started: %v", err)
			return
		}
		proxy.addr = addr
		proxy.started = true
		log.Printf("dns-proxy: CONNECT proxy on %s (resolver %s)", addr, ns)
		go func() {
			srv := &http.Server{Handler: http.HandlerFunc(proxy.handle)}
			if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
				log.Printf("dns-proxy: serve: %v", err)
			}
		}()
	})
}

// systemNameserver picks a UDP nameserver by IP: Android's net.dns{1,2}
// properties if readable, else public resolvers.
func systemNameserver() string {
	for _, p := range []string{"net.dns1", "net.dns2"} {
		out, err := exec.Command("/system/bin/getprop", p).Output()
		if err == nil {
			if s := strings.TrimSpace(string(out)); s != "" && net.ParseIP(s) != nil {
				return net.JoinHostPort(s, "53")
			}
		}
	}
	return "8.8.8.8:53"
}

// engineProxyEnv returns proxy env vars for engine spawns, or nil when the
// proxy is not running.
func engineProxyEnv() []string {
	if !proxy.started {
		return nil
	}
	return []string{
		"HTTP_PROXY=" + proxy.addr,
		"HTTPS_PROXY=" + proxy.addr,
		"NO_PROXY=127.0.0.1,localhost,::1",
	}
}

func (p *dnsProxy) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		// Plain HTTP requests: resolve the host and forward.
		p.forwardHTTP(w, r)
		return
	}
	host := r.Host
	if host == "" {
		http.Error(w, "no host", http.StatusBadRequest)
		return
	}
	if !strings.Contains(host, ":") {
		host += ":443"
	}
	dst, err := p.dialResolved(r.Context(), host)
	if err != nil {
		http.Error(w, "connect: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer dst.Close()

	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	conn, buf, err := hj.Hijack()
	if err != nil {
		http.Error(w, "hijack: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer conn.Close()
	io.WriteString(buf, "HTTP/1.1 200 Connection Established\r\n\r\n")
	buf.Flush()

	done := make(chan struct{}, 2)
	go func() { io.Copy(dst, conn); done <- struct{}{} }()
	go func() { io.Copy(conn, dst); done <- struct{}{} }()
	<-done
	<-done
}

func (p *dnsProxy) forwardHTTP(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if host == "" {
		http.Error(w, "no host", http.StatusBadRequest)
		return
	}
	if !strings.Contains(host, ":") {
		host += ":80"
	}
	dst, err := p.dialResolved(r.Context(), host)
	if err != nil {
		http.Error(w, "connect: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer dst.Close()
	r.RequestURI = ""
	if err := r.Write(dst); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	resp, err := http.ReadResponse(bufio.NewReader(dst), r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// dialResolved dials host:port, resolving via the by-IP UDP resolver.
func (p *dnsProxy) dialResolved(ctx context.Context, hostport string) (net.Conn, error) {
	h, port, err := net.SplitHostPort(hostport)
	if err != nil {
		return nil, fmt.Errorf("bad host:port %q", hostport)
	}
	if ip := net.ParseIP(h); ip != nil {
		return p.dialer.DialContext(ctx, "tcp", hostport)
	}
	ips, err := p.resolver.LookupIPAddr(ctx, h)
	if err != nil || len(ips) == 0 {
		return nil, fmt.Errorf("resolve %q: %v", h, err)
	}
	var last error
	for _, i := range ips {
		c, err := p.dialer.DialContext(ctx, "tcp", net.JoinHostPort(i.IP.String(), port))
		if err == nil {
			return c, nil
		}
		last = err
	}
	return nil, last
}
