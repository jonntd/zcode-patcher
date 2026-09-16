//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"unsafe"
)

// Windows console defaults are hostile to the patcher's ANSI + CJK output:
//   - Without ENABLE_VIRTUAL_TERMINAL_PROCESSING, CSI sequences print as
//     literal garbage.
//   - CP936/CP437 mangles the Chinese text the patcher prints (status/errors),
//     so lengths and output are wrong.
// The launcher owns the shared console before the node child inherits it, so
// we fix the modes here once. The output of `node zcode-patcher.js` is
// Unicode regardless of code page, so forcing UTF-8 is safe and correct.

const (
	stdInputHandle  = ^uint32(10 - 1) // (DWORD)-10
	stdOutputHandle = ^uint32(11 - 1) // (DWORD)-11
	stdErrorHandle  = ^uint32(12 - 1) // (DWORD)-12

	enableProcessedInput       = 0x0001
	enableVirtualTerminalInput = 0x0200
	enableProcessedOutput      = 0x0001
	enableWrapAtEolOutput      = 0x0002
	enableVirtualTerminalProc  = 0x0004
	disableNewlineAutoReturn   = 0x0008

	utf8CodePage = 65001
)

var (
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procGetStdHandle       = kernel32.NewProc("GetStdHandle")
	procGetConsoleMode     = kernel32.NewProc("GetConsoleMode")
	procSetConsoleMode     = kernel32.NewProc("SetConsoleMode")
	procGetConsoleCP       = kernel32.NewProc("GetConsoleCP")
	procGetConsoleOutputCP = kernel32.NewProc("GetConsoleOutputCP")
	procSetConsoleCP       = kernel32.NewProc("SetConsoleCP")
	procSetConsoleOutputCP = kernel32.NewProc("SetConsoleOutputCP")
)

// savedInputCP/savedOutputCP: code pages we switch the shared console to, kept
// so restoreWindowsConsole can put them back (a persistent 65001 is usually
// harmless, but is a needless side effect on the host cmd session).
var savedInputCP, savedOutputCP uint32

func getStdHandle(n uint32) (syscall.Handle, error) {
	r, _, err := procGetStdHandle.Call(uintptr(n))
	h := syscall.Handle(r)
	if h == 0 || h == syscall.InvalidHandle {
		if err != syscall.Errno(0) {
			return 0, err
		}
		return 0, syscall.EINVAL
	}
	return h, nil
}

func enableConsoleMode(handle syscall.Handle, add uint32) {
	var mode uint32
	r, _, _ := procGetConsoleMode.Call(uintptr(handle), uintptr(unsafe.Pointer(&mode)))
	if r == 0 {
		return // not a console (pipe/file) — leave alone
	}
	next := mode | add
	r, _, _ = procSetConsoleMode.Call(uintptr(handle), uintptr(next))
	if r != 0 {
		return
	}
	// Older consoles reject DISABLE_NEWLINE_AUTO_RETURN; retry without it so
	// VT processing still lands.
	if add&disableNewlineAutoReturn != 0 {
		procSetConsoleMode.Call(uintptr(handle), uintptr(mode|(add&^disableNewlineAutoReturn)))
	}
}

// prepareWindowsConsole turns on VT processing + UTF-8 so the patcher can
// render its ANSI coloring and CJK text without desync. Best-effort: failures
// are silent because a piped/redirected stdout is not a console at all.
func prepareWindowsConsole() {
	if r, _, _ := procGetConsoleOutputCP.Call(); r != 0 {
		savedOutputCP = uint32(r)
	}
	if r, _, _ := procGetConsoleCP.Call(); r != 0 {
		savedInputCP = uint32(r)
	}
	if h, err := getStdHandle(stdOutputHandle); err == nil {
		enableConsoleMode(h,
			enableProcessedOutput|
				enableWrapAtEolOutput|
				enableVirtualTerminalProc|
				disableNewlineAutoReturn,
		)
	}
	if h, err := getStdHandle(stdErrorHandle); err == nil {
		enableConsoleMode(h,
			enableProcessedOutput|
				enableWrapAtEolOutput|
				enableVirtualTerminalProc|
				disableNewlineAutoReturn,
		)
	}
	if h, err := getStdHandle(stdInputHandle); err == nil {
		// Keep line/echo flags the OS already set; only add VT input so
		// arrow keys from an interactive child still round-trip as CSI.
		enableConsoleMode(h, enableProcessedInput|enableVirtualTerminalInput)
	}
	procSetConsoleOutputCP.Call(uintptr(utf8CodePage))
	procSetConsoleCP.Call(uintptr(utf8CodePage))
}

// restoreWindowsConsole puts the shared console code pages back. Deferred from
// runChild — os.Exit in main would skip it.
func restoreWindowsConsole() {
	if savedOutputCP != 0 {
		procSetConsoleOutputCP.Call(uintptr(savedOutputCP))
	}
	if savedInputCP != 0 {
		procSetConsoleCP.Call(uintptr(savedInputCP))
	}
}

func runChild(bin string, args []string, env []string) int {
	prepareWindowsConsole()
	defer restoreWindowsConsole()

	cmd := exec.Command(bin, args...)
	cmd.Env = env
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// Let the child handle Ctrl+C; the launcher just waits.
	signal.Ignore(os.Interrupt)
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode()
		}
		fmt.Fprintln(os.Stderr, "zcode-patcher: failed to run runtime:", err)
		return 1
	}
	return 0
}
