@echo off
REM Starts the local dashboard server (keep this window open) and opens it in your browser.
REM Use the "Refresh now" button on the page to pull new results.
cd /d "%~dp0"
node serve.mjs --open
pause
