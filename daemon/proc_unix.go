//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// startInOwnGroup puts the engine in its own process group so killTree can
// also stop the language servers and shells it spawns.
func startInOwnGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killTree kills cmd's process group, falling back to the process alone.
func killTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		cmd.Process.Kill()
	}
}
