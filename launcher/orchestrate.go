package main

// 一键全量流程的运行中守卫编排（对齐 scripts/zcode-patch shell 包装的行为）：
//
//	--apply-all / 裸 -f：
//	    ZCode 在跑 → 拒绝（提示加 -f）；带 -f → 优雅退出 + 最多等 20 秒
//	    → 打完全部补丁 → 成功后自动拉起 ZCode
//	-f 搭配单个补丁 flag：只做「优雅退出 + 等待」，随后照常透传（不拉起）
//	--check / --revert / --status 等其余参数：不加守卫，与 shell 版一致
//
// 进程管理刻意放在 Go 层而不是 JS 引擎里：引擎保持纯文件操作，便于单独测试；
// 优雅退出的手段按平台分派（macOS osascript / Windows CloseMainWindow / Linux SIGTERM），
// 全部走命令行工具，不引入 CGO。

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const quitWaitSeconds = 20

// zcodeRunning reports whether a ZCode main process is alive. Matches the
// executable's own name only, so ZCode Helper / zcode-cli 等旁路进程不误报。
func zcodeRunning() bool {
	switch runtime.GOOS {
	case "windows":
		// 只取 PID 数字，避开 PowerShell 输出编码随 OEM 代码页变化的坑
		out, err := exec.Command("powershell", "-NoProfile", "-Command",
			"Get-Process | Where-Object { $_.Path -and (Split-Path $_.Path -Leaf) -ieq 'ZCode.exe' } | Select-Object -First 1 -ExpandProperty Id").
			Output()
		return err == nil && strings.TrimSpace(string(out)) != ""
	default:
		out, err := exec.Command("ps", "-eo", "comm=").Output()
		if err != nil {
			return false
		}
		for _, line := range strings.Split(string(out), "\n") {
			name := strings.TrimSpace(line)
			if name == "ZCode" || name == "zcode" || strings.HasSuffix(name, "/ZCode") || strings.HasSuffix(name, "/zcode") {
				return true
			}
		}
		return false
	}
}

// gracefulQuitZCode asks the main process to quit politely（给保存现场的机会），
// 绝不强杀；等不到退出就返回错误，由调用方放弃本次打补丁。
func gracefulQuitZCode() error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("osascript", "-e", `quit app "ZCode"`).Run()
	case "windows":
		return exec.Command("powershell", "-NoProfile", "-Command",
			"(Get-Process | Where-Object { $_.Path -and (Split-Path $_.Path -Leaf) -ieq 'ZCode.exe' }) | ForEach-Object { [void]$_.CloseMainWindow() }").Run()
	default:
		exec.Command("pkill", "-TERM", "-x", "ZCode").Run()
		return exec.Command("pkill", "-TERM", "-x", "zcode").Run()
	}
}

func waitZcodeGone() bool {
	for i := 0; i < quitWaitSeconds; i++ {
		if !zcodeRunning() {
			return true
		}
		time.Sleep(1 * time.Second)
	}
	return !zcodeRunning()
}

// relaunchZCode best-effort；失败只提示，不影响退出码。
func relaunchZCode() {
	switch runtime.GOOS {
	case "darwin":
		if err := exec.Command("open", "-a", "ZCode").Run(); err == nil {
			fmt.Println("[√] 全部补丁就绪，已启动 ZCode")
			return
		}
	case "windows":
		for _, dir := range []string{os.Getenv("LOCALAPPDATA"), os.Getenv("ProgramFiles"), os.Getenv("ProgramW6432")} {
			if dir == "" {
				continue
			}
			for _, cand := range []string{
				filepath.Join(dir, "Programs", "ZCode", "ZCode.exe"),
				filepath.Join(dir, "ZCode", "ZCode.exe"),
			} {
				if _, err := os.Stat(cand); err != nil {
					continue
				}
				if err := exec.Command("cmd", "/c", "start", "", cand).Start(); err == nil {
					fmt.Println("[√] 全部补丁就绪，已启动 ZCode")
					return
				}
			}
		}
	default:
		for _, exe := range []string{"/opt/ZCode/zcode", "/opt/zcode/zcode", "/usr/share/zcode/zcode"} {
			if _, err := os.Stat(exe); err == nil {
				if err := exec.Command(exe).Start(); err == nil {
					fmt.Println("[√] 全部补丁就绪，已启动 ZCode")
					return
				}
			}
		}
	}
	fmt.Println("[√] 全部补丁就绪，请手动启动 ZCode")
}

// runAndWait spawns the JS child and waits, keeping stdio wired to the
// terminal（unix 的 runChild 是 syscall.Exec 进程替换，打完补丁后还要拉起
// ZCode，所以编排路径必须用可等待的子进程）。
func runAndWait(rt jsRuntime, args []string) int {
	prepareChildConsole()
	cmd := exec.Command(rt.bin, args...)
	cmd.Env = childEnv(rt)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode()
		}
		fmt.Fprintln(os.Stderr, "zcode-patcher: failed to run runtime:", err)
		return 1
	}
	return 0
}

func childEnv(rt jsRuntime) []string {
	env := os.Environ()
	if rt.electron {
		env = append(env, "ELECTRON_RUN_AS_NODE=1")
	}
	return env
}

// orchestrateApplyAll 实现带守卫的一键全打。返回 (exitCode, handled)：
// handled=false 表示参数不属于编排路径，调用方走原有透传。
func orchestrateApplyAll(rt jsRuntime, args []string, force bool) (int, bool) {
	isApplyAll := false
	rest := make([]string, 0, len(args))
	for _, a := range args {
		if a == "--apply-all" {
			isApplyAll = true
			continue
		}
		rest = append(rest, a)
	}
	// 裸 -f 是 shell 版 `zcode-patch -f` 的等价物，也走一键全量
	loneForce := force && len(rest) == 0
	if !isApplyAll && !loneForce {
		if force {
			return forceQuitThenPass(rt, rest), true
		}
		return 0, false
	}

	if zcodeRunning() {
		if !force {
			fmt.Println("[!] ZCode 正在运行。请先完全退出（⌘Q）后重试，或加 -f 自动退出")
			return 1, true
		}
		fmt.Println("[i] 正在退出 ZCode ...")
		gracefulQuitZCode()
		if !waitZcodeGone() {
			fmt.Println("[x] ZCode 未能退出，放弃")
			return 1, true
		}
	}

	if loneForce {
		rest = []string{"--apply-all"} // 非交互全打；裸 TUI 交互菜单路径保持不变
	}
	code := runAndWait(rt, append([]string{filepath.Join(unpackDir, "zcode-tui.js")}, rest...))
	if code == 0 {
		relaunchZCode()
	}
	return code, true
}

// forceQuitThenPass handles `-f <单个补丁flag>`：退出后透传，不拉起。
func forceQuitThenPass(rt jsRuntime, rest []string) int {
	modifying := true
	for _, a := range rest {
		switch a {
		case "--check", "--revert", "--status", "--check-all", "--json":
			modifying = false
		}
	}
	if modifying && zcodeRunning() {
		fmt.Println("[i] 正在退出 ZCode ...")
		gracefulQuitZCode()
		if !waitZcodeGone() {
			fmt.Println("[x] ZCode 未能退出，放弃")
			return 1
		}
	}
	return runAndWait(rt, append([]string{filepath.Join(unpackDir, "zcode-patcher.js")}, rest...))
}
