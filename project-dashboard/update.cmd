@echo off
rem Downloads the latest project dashboard from GitHub (BWERepo/Dashboards, branch claude/project-thread-3c2lon),
rem then restarts it. GitHub can take a few minutes to serve a just-pushed change.
cd /d "%~dp0"
set B=https://raw.githubusercontent.com/BWERepo/Dashboards/claude/project-thread-3c2lon/project-dashboard
for %%f in (build.mjs serve.mjs page-template.html projects.mjs refresh.cmd) do (
  curl.exe -fsSL -o "%%f.new" "%B%/%%f" && move /y "%%f.new" "%%f" >nul && echo Updated %%f || echo Could not download %%f
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:8788" ^| findstr LISTENING') do taskkill /pid %%p /f >nul
start "Project dashboard" /min cmd /c "node serve.mjs --open"
