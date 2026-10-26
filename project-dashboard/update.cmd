@echo off
rem Downloads the latest project dashboard from GitHub (BWERepo/Dashboards, branch claude/project-thread-3c2lon),
rem then restarts it. Files are fetched by the branch's newest commit id, because GitHub caches branch links for minutes.
cd /d "%~dp0"
set SHA=
for /f %%s in ('curl.exe -fsSL -H "Accept: application/vnd.github.sha" https://api.github.com/repos/BWERepo/Dashboards/commits/claude/project-thread-3c2lon') do set SHA=%%s
if "%SHA%"=="" (echo Could not reach GitHub. Nothing was changed. & pause & exit /b 1)
echo Updating to %SHA%
set B=https://raw.githubusercontent.com/BWERepo/Dashboards/%SHA%/project-dashboard
for %%f in (build.mjs serve.mjs page-template.html projects.mjs refresh.cmd) do (
  curl.exe -fsSL -o "%%f.new" "%B%/%%f" && move /y "%%f.new" "%%f" >nul && echo Updated %%f || echo Could not download %%f
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:8788" ^| findstr LISTENING') do taskkill /pid %%p /f >nul
start "Project dashboard" /min cmd /c "node serve.mjs --open"
rem Last: replace this script itself. Both commands sit on one line, which cmd has already read, so this is safe.
curl.exe -fsSL -o update.cmd.new "%B%/update.cmd" && (move /y update.cmd.new update.cmd >nul & exit /b 0)
