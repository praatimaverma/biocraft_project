@echo off
REM Creates two Windows scheduled tasks (9:00 and 21:00) that run the sync agent.
REM They run as SYSTEM, so they work whether or not anyone is logged in via Remote Desktop.
REM Right-click this file > "Run as administrator".

set "FOLDER=%~dp0"
if "%FOLDER:~-1%"=="\" set "FOLDER=%FOLDER:~0,-1%"

set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE (
  echo Node.js was not found. Install Node.js LTS from nodejs.org, then run this again.
  pause
  exit /b 1
)

if not exist "%FOLDER%\.env" (
  echo .env is missing. Copy .env.example to .env and fill it in first.
  pause
  exit /b 1
)

echo Using Node: %NODE%
echo Folder:     %FOLDER%

schtasks /Create /F /TN "BiocraftTallySync-0900" /SC DAILY /ST 09:00 /RU SYSTEM /RL HIGHEST /TR "cmd /c cd /d \"%FOLDER%\" && \"%NODE%\" agent.js"
schtasks /Create /F /TN "BiocraftTallySync-2100" /SC DAILY /ST 21:00 /RU SYSTEM /RL HIGHEST /TR "cmd /c cd /d \"%FOLDER%\" && \"%NODE%\" agent.js"

echo.
echo Done. To test right now:   schtasks /Run /TN "BiocraftTallySync-0900"
echo Then read:                 %FOLDER%\sync.log
pause
