@echo off
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js 24 or Node.js 22.19+ is required.
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo ERROR: pnpm was not found. Run: npm install -g pnpm
  pause
  exit /b 1
)

py -3.11 --version >nul 2>nul
if errorlevel 1 (
  echo ERROR: Python 3.11 is required for document, audio and GIS extraction.
  pause
  exit /b 1
)

echo [1/4] Installing and building the built-in runtime...
pushd "vendor\runtime"
call pnpm install --frozen-lockfile
if errorlevel 1 (popd & goto :failed)
call pnpm build
if errorlevel 1 (popd & goto :failed)
popd

echo [2/4] Installing knowledge graph and page assets...
pushd "packages\intake"
call npm ci --omit=dev --legacy-peer-deps
if errorlevel 1 (popd & goto :failed)
popd

echo [3/4] Installing document, audio and GIS extraction dependencies...
py -3.11 -m pip install -r requirements.txt
if errorlevel 1 goto :failed

echo [4/4] Validating the Wenshan configuration...
node "scripts\run.mjs" web --dump-config >nul
if errorlevel 1 goto :failed

echo.
echo Installation completed. Run scripts\start.bat to open 问山：地理野外实习自成长智能助手.
pause
exit /b 0

:failed
echo.
echo ERROR: Installation or configuration validation failed. Keep the log above.
pause
exit /b 1
