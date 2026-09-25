@echo off
setlocal enabledelayedexpansion
title RelayDeck

:: 1. Localizar la carpeta donde se encuentra server.js
set "TARGET_DIR=%~dp0"
if exist "%~dp0codex-panel\server.js" (
    set "TARGET_DIR=%~dp0codex-panel"
) else if not exist "%~dp0server.js" (
    echo [ERROR] No se pudo encontrar server.js en el directorio actual ni en codex-panel.
    pause
    exit /b 1
)

cd /d "!TARGET_DIR!"

:: 2. Verificar que Node.js este instalado y disponible en el PATH
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js no esta instalado o no se encuentra en el PATH del sistema.
    echo Por favor instala Node.js - version 20 o superior - para ejecutar RelayDeck.
    pause
    exit /b 1
)

:: 3. Determinar el puerto configurado (default: 7788)
set "PORT=%RELAYDECK_PORT%"
if "!PORT!"=="" set "PORT=%CODEX_PANEL_PORT%"
if "!PORT!"=="" set "PORT=7788"

:: 4. Verificar si ya existe una instancia escuchando en dicho puerto
netstat -ano -p tcp | findstr /C:":!PORT! " | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo.
    echo =====================================================================
    echo   [AVISO] Ya hay una instancia de RelayDeck activa en el puerto !PORT!.
    echo   No se iniciara un nuevo servidor para evitar duplicados.
    echo =====================================================================
    echo.
    echo Abriendo la interfaz en tu navegador: http://127.0.0.1:!PORT!
    start http://127.0.0.1:!PORT!
    echo.
    pause
    exit /b 0
)

:: 5. Si no hay otra instancia, iniciar el servidor
echo.
echo =====================================================================
echo   Iniciando RelayDeck en http://127.0.0.1:!PORT! ...
echo =====================================================================
echo.
node server.js

if errorlevel 1 (
    echo.
    echo [INFO] El servidor se ha detenido con codigo !errorlevel!.
    pause
)
