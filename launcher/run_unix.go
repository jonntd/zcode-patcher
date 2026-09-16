//go:build !windows

package main

import (
	"fmt"
	"os"
	"syscall"
)

// On unix, replace the launcher process entirely with node so the child owns
// the terminal and inherits signals directly.
func runChild(bin string, args []string, env []string) int {
	argv := append([]string{bin}, args...)
	err := syscall.Exec(bin, argv, env)
	// Exec only returns on failure.
	fmt.Fprintln(os.Stderr, "zcode-patcher: failed to exec runtime:", err)
	return 1
}
