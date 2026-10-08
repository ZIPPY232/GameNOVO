//go:build windows

// Lightweight Windows launcher: the whole game (single-file standalone build)
// is embedded in the executable, extracted to the user's local app data and
// opened in a chromeless Edge/Chrome app window with GPU-friendly flags.
package main

import (
	"bytes"
	_ "embed"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

//go:embed game.html
var game []byte

func main() {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "HorizonteVoxel")
	page := filepath.Join(dir, "jogo", "index.html")
	if err := install(page); err != nil {
		fail("Não foi possível preparar os arquivos do jogo:\n" + err.Error())
		return
	}
	u := (&url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(page)}).String()

	browser := findBrowser()
	if browser == "" {
		// no Chromium browser: fall back to the default handler for .html
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", page).Start()
		return
	}
	args := []string{
		"--app=" + u,
		"--user-data-dir=" + filepath.Join(dir, "perfil"),
		"--ignore-gpu-blocklist",
		"--force_high_performance_gpu",
		"--start-maximized",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate",
		"--autoplay-policy=no-user-gesture-required",
	}
	if err := exec.Command(browser, args...).Start(); err != nil {
		fail("Não foi possível abrir o navegador:\n" + err.Error())
	}
}

// install writes the embedded page only when it changed (keeps updates cheap).
func install(page string) error {
	if old, err := os.ReadFile(page); err == nil && bytes.Equal(old, game) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(page), 0o755); err != nil {
		return err
	}
	return os.WriteFile(page, game, 0o644)
}

func findBrowser() string {
	pf := os.Getenv("ProgramFiles")
	pf86 := os.Getenv("ProgramFiles(x86)")
	local := os.Getenv("LOCALAPPDATA")
	candidates := []string{
		filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(local, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(pf, `BraveSoftware\Brave-Browser\Application\brave.exe`),
	}
	for _, c := range candidates {
		if strings.HasPrefix(c, `\`) {
			continue // env var missing
		}
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	for _, name := range []string{"msedge", "chrome"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}

func fail(msg string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	box := user32.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(msg)
	c, _ := syscall.UTF16PtrFromString("Horizonte")
	box.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x10)
}
