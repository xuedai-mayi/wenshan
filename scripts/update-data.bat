@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0.."

rem 重建数据（GDB + 知识库 + 每日整理 -> data/）。
rem 站点配置默认 config\lushan.json，可传参切换实习区：update-data.bat config\<站点>.json
set CFG=%~1
if "%CFG%"=="" set CFG=config\lushan.json

echo [数据] %CFG%
python scripts\build_data.py "%CFG%"
if errorlevel 1 goto :err

echo.
echo ✔ 数据已更新到 data\
echo   重启问山后即可读取新的基础数据。
pause
goto :eof

:err
echo ✘ 失败，请查看上方报错。
pause
exit /b 1
