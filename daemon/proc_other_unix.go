//go:build !windows && !linux

package main

import "syscall"

// dieWithParent has no portable equivalent outside Linux.
func dieWithParent(a *syscall.SysProcAttr) {}
