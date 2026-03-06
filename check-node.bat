@echo off
chcp 65001 >nul 2>&1
cls

echo ============================================
echo    Проверка Node.js
echo ============================================
echo.

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js не установлен!
    echo.
    echo Запустите install-node.bat для установки.
) else (
    echo [OK] Node.js установлен:
    node --version
    echo.
    echo [OK] npm установлен:
    npm --version
)

echo.
pause
