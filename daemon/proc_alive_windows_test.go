//go:build windows

package main

import (
	"os/exec"
	"strconv"
	"strings"
)

func processAlive(pid int) bool {
	out, _ := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/NH").Output()
	return strings.Contains(string(out), " "+strconv.Itoa(pid)+" ")
}
