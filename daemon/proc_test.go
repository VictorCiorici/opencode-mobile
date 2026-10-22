package main

import (
	"bufio"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestMain lets the test binary double as a helper process: "parent" starts
// a "child" and prints its PID, the child just sleeps.
func TestMain(m *testing.M) {
	switch os.Getenv("OF_PROC_HELPER") {
	case "parent", "engine-parent":
		c := exec.Command(os.Args[0])
		c.Env = append(os.Environ(), "OF_PROC_HELPER=child")
		if os.Getenv("OF_PROC_HELPER") == "engine-parent" {
			startInOwnGroup(c) // spawned the way the daemon spawns engines
		}
		if err := c.Start(); err != nil {
			os.Exit(2)
		}
		os.Stdout.WriteString(strconv.Itoa(c.Process.Pid) + "\n")
		c.Wait()
		os.Exit(0)
	case "child":
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestKillTreeStopsGrandchildren(t *testing.T) {
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "OF_PROC_HELPER=parent")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	startInOwnGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		killTree(cmd)
		t.Fatalf("no child pid: %v", err)
	}
	childPID, _ := strconv.Atoi(strings.TrimSpace(line))
	inst := &Instance{Cmd: cmd, exited: make(chan struct{})}
	go func() { cmd.Wait(); close(inst.exited) }()

	inst.kill()
	select {
	case <-inst.exited:
	case <-time.After(10 * time.Second):
		t.Fatal("engine process survived kill")
	}
	deadline := time.Now().Add(10 * time.Second)
	for processAlive(childPID) {
		if time.Now().After(deadline) {
			t.Fatalf("grandchild %d survived kill", childPID)
		}
		time.Sleep(100 * time.Millisecond)
	}
	// Killing an already-reaped instance is a no-op, not a stray signal.
	inst.kill()
}

func TestAllocPortSkipsBusyPorts(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	busy := ln.Addr().(*net.TCPAddr).Port
	m := &Manager{nextPort: busy}
	if got := m.allocPort(); got == busy {
		t.Fatalf("allocPort returned busy port %d", busy)
	}
	if m.nextPort <= busy {
		t.Fatalf("nextPort did not advance: %d", m.nextPort)
	}
}
