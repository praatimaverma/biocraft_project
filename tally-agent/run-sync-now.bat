@echo off
REM Runs one full Tally -> Supabase sync right now and shows the result.
cd /d "%~dp0"
node agent.js
echo.
echo Exit code: %errorlevel%  (0 = OK). Details are in sync.log
pause
