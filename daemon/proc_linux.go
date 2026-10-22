//go:build linux

package main

import "syscall"

// dieWithParent has the kernel kill the engine if the daemon dies, including
// from SIGKILL (Android kills a stale daemon that way after an app update),
// which leaves no chance to run StopAll.
func dieWithParent(a *syscall.SysProcAttr) {
	a.Pdeathsig = syscall.SIGKILL
}
