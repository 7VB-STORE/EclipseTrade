@echo off
chcp 65001 >nul 2>&1
cls

echo ============================================
echo    EclipseTradeBot
echo ============================================
echo.
echo If Steam not connecting:
echo 1. Enable VPN and run start.bat again
echo 2. Or set proxy: set STEAM_PROXY=http://ip:port
echo.
echo ============================================
echo.

if defined STEAM_PROXY (
    echo [INFO] Using proxy: %STEAM_PROXY%
) else (
    echo [INFO] No proxy set. Enable VPN if needed.
)

echo [INFO] Starting application...
echo.

npm start

pause
