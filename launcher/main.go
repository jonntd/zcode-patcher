// zcode-patcher launcher: a tiny native executable that carries the patch
// bundle (go:embed) and delegates execution to a JS runtime already on the
// machine — system node, or a VS Code-family editor's Electron with
// ELECTRON_RUN_AS_NODE=1. No Node runtime is bundled, which keeps the binary
// at a few MB instead of ~50MB (pkg).
//
// The embedded bundle and its __dirname-relative sidecars are materialized to
// ~/.zcode/patcher/ and the main script is executed with the original CLI
// flags. zcode-patcher.js resolves sidecars (zcode-tps.js, zcode-enhance.js,
// zcode-continue.js, modelhub_payload.json) with path.join(__dirname, …), so
// they must land in the same dir as the main script.
//
// Build (the five embedded files must exist in this dir first — see
// scripts/build-launcher.js):
//
//	node scripts/build-launcher.js            # windows targets (.exe)
//	node scripts/build-launcher.js --all      # + macOS / Linux
//	node scripts/build-launcher.js --host     # just this platform
package main

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

//go:embed zcode-patcher.js
var mainScript []byte

//go:embed zcode-tui.js
var zcodeTUI []byte

//go:embed zcode-tps.js
var zcodeTPS []byte

//go:embed zcode-enhance.js
var zcodeEnhance []byte

//go:embed zcode-continue.js
var zcodeContinue []byte

//go:embed modelhub_payload.json
var modelhubPayload []byte

// Overridden at build time: -ldflags "-X main.version=X.Y.Z". Used only as a
// cache marker so a stale exe does not overwrite a newer cached bundle.
var version = "0.0.0"

// unpackDir is where we materialize the bundle and its sidecars.
var unpackDir = func() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return filepath.Join(home, ".zcode", "patcher")
}()

// name + embedded data for every file that must sit next to the main script.
var files = []struct {
	name string
	data []byte
}{
	{"zcode-patcher.js", mainScript},
	{"zcode-tui.js", zcodeTUI},
	{"zcode-tps.js", zcodeTPS},
	{"zcode-enhance.js", zcodeEnhance},
	{"zcode-continue.js", zcodeContinue},
	{"modelhub_payload.json", modelhubPayload},
}

func materialize() (string, error) {
	if err := os.MkdirAll(unpackDir, 0o755); err != nil {
		return "", err
	}
	var mainPath string
	for i, f := range files {
		p := filepath.Join(unpackDir, f.name)
		if err := writeIfChanged(p, f.data); err != nil {
			return "", err
		}
		if i == 0 {
			mainPath = p
		}
	}
	return mainPath, nil
}

// writeIfChanged skips the write when an identical byte-for-byte file is
// already in place, so repeated runs don't churn the unpack dir or trip
// antivirus/indexers. Writes go through a temp file + rename for atomicity.
func writeIfChanged(path string, data []byte) error {
	if cur, err := os.ReadFile(path); err == nil && string(cur) == string(data) {
		return nil
	}
	tmp := fmt.Sprintf("%s.tmp-%d", path, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// jsRuntime is a JS interpreter we can delegate to: system node, or a
// VS Code-family editor's Electron run as plain node.
type jsRuntime struct {
	bin      string
	electron bool
}

// findRuntime prefers a real `node` on PATH. When none is installed, it falls
// back to the first VS Code-family editor's Electron it can find, launched
// with ELECTRON_RUN_AS_NODE=1 so it behaves as node. That way Windows users
// without Node can still run the patcher if they have any such editor.
func findRuntime() (jsRuntime, error) {
	if p, err := exec.LookPath("node"); err == nil {
		return jsRuntime{bin: p}, nil
	}
	for _, cand := range electronCandidates() {
		if fi, err := os.Stat(cand); err == nil && fi.Mode().IsRegular() {
			return jsRuntime{bin: cand, electron: true}, nil
		}
	}
	return jsRuntime{}, fmt.Errorf(
		"zcode-patcher: no JS runtime found - install Node.js (https://nodejs.org) or a VS Code-family editor")
}

func main() {
	_, err := materialize()
	if err != nil {
		fmt.Fprintln(os.Stderr, "zcode-patcher: failed to unpack bundle:", err)
		os.Exit(1)
	}
	rt, err := findRuntime()
	if err != nil {
		fmt.Fprintln(os.Stderr, "zcode-patcher:", err)
		os.Exit(1)
	}
	env := os.Environ()
	if rt.electron {
		env = append(env, "ELECTRON_RUN_AS_NODE=1")
	}
	// Entry selection:
	//   - bare invocation (no args)            -> interactive patch menu
	//   - --status / --check-all               -> non-interactive status text
	//   - any other flags / a target path      -> CLI (zcode-patcher.js)
	var entry string
	switch {
	case len(os.Args) <= 1:
		entry = filepath.Join(unpackDir, "zcode-tui.js") // interactive menu
	case isStatusArg(os.Args[1:]):
		entry = filepath.Join(unpackDir, "zcode-tui.js") // status report
	default:
		entry = filepath.Join(unpackDir, "zcode-patcher.js") // CLI passthrough
	}
	// -f / --force 只属于编排层（守卫 + 优雅退出 + 拉起），引擎不认识这个 flag，
	// 透传前必须剥掉。
	force := false
	args := make([]string, 0, len(os.Args))
	for _, a := range os.Args[1:] {
		if a == "-f" || a == "--force" {
			force = true
			continue
		}
		args = append(args, a)
	}
	if code, handled := orchestrateApplyAll(rt, args, force); handled {
		os.Exit(code)
	}
	args = append([]string{entry}, args...)
	os.Exit(runChild(rt.bin, args, env))
}

func isStatusArg(args []string) bool {
	for _, a := range args {
		switch a {
		case "--status", "--check-all", "--apply-all", "--revert-all", "--json":
			return true
		}
	}
	return false
}

// electronCandidates returns likely editor Electron binaries for the current
// platform, in preference order (most common first).
func electronCandidates() []string {
	switch runtime.GOOS {
	case "windows":
		la := os.Getenv("LOCALAPPDATA")
		pf := os.Getenv("ProgramFiles")
		return []string{
			filepath.Join(la, "Programs", "Microsoft VS Code", "Code.exe"),
			filepath.Join(pf, "Microsoft VS Code", "Code.exe"),
			filepath.Join(la, "Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe"),
			filepath.Join(la, "Programs", "VSCodium", "VSCodium.exe"),
			filepath.Join(la, "Programs", "cursor", "Cursor.exe"),
			filepath.Join(la, "Programs", "Windsurf", "Windsurf.exe"),
			filepath.Join(la, "Programs", "Trae", "Trae.exe"),
			filepath.Join(la, "Programs", "Trae CN", "Trae CN.exe"),
		}
	case "darwin":
		home, _ := os.UserHomeDir()
		apps := []string{
			"Visual Studio Code.app",
			"Visual Studio Code - Insiders.app",
			"VSCodium.app",
			"Cursor.app",
			"Windsurf.app",
			"Trae.app",
			"Trae CN.app",
			"Antigravity IDE.app",
		}
		var out []string
		for _, app := range apps {
			for _, root := range []string{"/Applications", filepath.Join(home, "Applications")} {
				matches, _ := filepath.Glob(filepath.Join(root, app, "Contents", "MacOS", "*"))
				out = append(out, matches...)
			}
		}
		return out
	default:
		return []string{
			"/usr/share/code/code",
			"/usr/share/code-insiders/code-insiders",
			"/usr/share/codium/codium",
			"/opt/visual-studio-code/code",
			"/usr/lib/code/code",
		}
	}
}
