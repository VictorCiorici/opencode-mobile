//go:build !windows

package main

import "syscall"

func processAlive(pid int) bool {
	var ws syscall.WaitStatus
	// Reap it if it is our zombie; otherwise probe with signal 0.
	syscall.Wait4(pid, &ws, syscall.WNOHANG, nil)
	return syscall.Kill(pid, 0) == nil
}
