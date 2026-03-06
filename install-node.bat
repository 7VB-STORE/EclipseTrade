@echo off
chcp 65001 >nul 2>&1
cls

echo ============================================
echo    Установка Node.js
echo ============================================
echo.
echo Node.js будет загружен и установлен.
echo.
pause

echo [INFO] Downloading Node.js installer...
curl -L -o node-installer.msi https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi

echo [INFO] Installing Node.js...
msiexec /i node-installer.msi /quiet

echo [INFO] Installation complete!
echo.
echo Please restart your computer if required.
del node-installer.msi

pause
