//go:build linux

package main

import (
	"bufio"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A hard-killed daemon must not leave its engines running.
func TestEngineDiesWithKilledDaemon(t *testing.T) {
	daemon := exec.Command(os.Args[0])
	daemon.Env = append(os.Environ(), "OF_PROC_HELPER=engine-parent")
	out, err := daemon.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		daemon.Process.Kill()
		t.Fatalf("no engine pid: %v", err)
	}
	engine, _ := strconv.Atoi(strings.TrimSpace(line))
	defer syscall.Kill(engine, syscall.SIGKILL)

	daemon.Process.Signal(syscall.SIGKILL)
	daemon.Wait()
	deadline := time.Now().Add(10 * time.Second)
	for processAlive(engine) {
		if time.Now().After(deadline) {
			t.Fatalf("engine %d outlived its SIGKILLed daemon", engine)
		}
		time.Sleep(100 * time.Millisecond)
	}
}
