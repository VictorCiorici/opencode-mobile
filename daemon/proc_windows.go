//go:build windows

package main

import (
	"os/exec"
	"strconv"
)

// startInOwnGroup is a no-op on Windows; killTree walks the tree instead.
func startInOwnGroup(cmd *exec.Cmd) {}

// killTree kills cmd and its descendants. On Windows the engine is usually an
// opencode.cmd wrapper, and killing only the wrapper orphans the real engine.
func killTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
	cmd.Process.Kill()
}
