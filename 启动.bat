@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found. Run the installer first.
  pause
  exit /b 1
)

if not exist "deepseek-harness-master\deepseek-harness-master\apps\cli\lib\bin.js" (
  echo ERROR: The bundled DSH runtime has not been built. Run the installer first.
  pause
  exit /b 1
)

echo 问山：地理野外实习自成长智能助手正在启动: http://127.0.0.1:3080/
echo Knowledge graph: http://127.0.0.1:3080/wenshan/knowledge-graph
echo Press Ctrl+C to stop.
echo.
node "tools\run_wenshan.mjs" web
