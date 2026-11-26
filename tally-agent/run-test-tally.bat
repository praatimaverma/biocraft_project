@echo off
REM Checks that Tally answers and shows what it finds. Sends NOTHING to Supabase.
cd /d "%~dp0"
node agent.js --test
pause
