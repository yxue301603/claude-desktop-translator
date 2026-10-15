@echo off
chcp 65001 >nul
cd /d "%~dp0"
node bin\offline.mjs launch
if errorlevel 1 pause
