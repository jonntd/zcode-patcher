@echo off
rem ============================================================================
rem zcode-patch 的 Windows 版（对应 macOS/Linux 上 alias 进 ~/.zshrc 的 zcode-patch）
rem 需 Windows 10+。Program Files / /Applications 类目录安装时请用管理员终端运行。
rem
rem 用法：
rem   zcode-patch.cmd            打/重打全部补丁（六个 asar 补丁 + edit-all + 思考等级）
rem   zcode-patch.cmd check      全部补丁状态
rem   zcode-patch.cmd revert     全部还原（先 edit-all 再内核备份，符合文档还原顺序）
rem   zcode-patch.cmd -f         先退出 ZCode，打完全部补丁后尝试重启
rem
rem 前置：把 scripts 下五个文件复制到 %USERPROFILE%\.zcode\patcher\
rem       （zcode-patcher.js / modelhub_payload.json / zcode-tps.js /
rem         zcode-enhance.js / zcode-continue.js）
rem ============================================================================
setlocal EnableExtensions
chcp 65001 >nul

set "PATCH_DIR=%USERPROFILE%\.zcode\patcher"
set "PATCHER=%PATCH_DIR%\zcode-patcher.js"
if not exist "%PATCHER%" set "PATCHER=%~dp0zcode-patcher.js"
if not exist "%PATCHER%" (
  echo [x] 未找到 zcode-patcher.js，请先把 scripts 下五个文件复制到 %PATCH_DIR%
  exit /b 1
)

set "ASAR_FLAGS=--usage-chart --menu-width --continue-btn --tps-footer --modelhub --enhance-btn"

if /i "%~1"=="check" (
  node "%PATCHER%" --check
  node "%PATCHER%" --check %ASAR_FLAGS% --edit-all
  exit /b 0
)

if /i "%~1"=="revert" (
  node "%PATCHER%" --revert %ASAR_FLAGS% --edit-all
  node "%PATCHER%" --revert
  echo [i] 已全部还原，重启 ZCode 生效
  exit /b 0
)

if "%~1"=="-f" call :quit_zcode

node "%PATCHER%" %ASAR_FLAGS% --edit-all
node "%PATCHER%"
if errorlevel 1 (
  echo [x] 补丁执行失败，按上方输出排查；还原命令：zcode-patch.cmd revert
  exit /b 1
)

if "%~1"=="-f" call :start_zcode
echo [i] 完成。ZCode 升级会覆盖内核与 app.asar，升级后重跑本脚本即可。
exit /b 0

:quit_zcode
rem 先优雅关闭（等价点窗口 ×），2 秒后仍在运行再强杀
taskkill /IM ZCode.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul
tasklist /FI "IMAGENAME eq ZCode.exe" 2>nul | find /I "ZCode.exe" >nul && taskkill /IM ZCode.exe /T /F >nul 2>&1
timeout /t 1 /nobreak >nul
exit /b 0

:start_zcode
set "EXE=%LOCALAPPDATA%\Programs\ZCode\ZCode.exe"
if exist "%EXE%" ( start "" "%EXE%" & exit /b 0 )
if exist "%ProgramFiles%\ZCode\ZCode.exe" ( start "" "%ProgramFiles%\ZCode\ZCode.exe" & exit /b 0 )
if exist "%ProgramW6432%\ZCode\ZCode.exe" ( start "" "%ProgramW6432%\ZCode\ZCode.exe" & exit /b 0 )
echo [!] 未找到 ZCode.exe，请手动启动 ZCode
exit /b 0
