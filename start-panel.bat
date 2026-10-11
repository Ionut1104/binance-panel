@echo off
title Binance Panel
cd /d "%~dp0server"
start "" cmd /c "timeout /t 2 /nobreak >nul && start "" http://localhost:8787"
powershell -NoProfile -Command "& { npm start 2>&1 | Tee-Object -FilePath 'server.log' }"
echo.
echo Server stopped. Full log is in server\server.log
pause
