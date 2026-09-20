@echo off
setlocal EnableExtensions
REM ============================================================
REM  Operant - Registro del Native Messaging Host (Windows)
REM  Uso: install_host.bat <ID_EXTENSION>
REM
REM  El ID de la extension se copia desde:
REM    chrome://extensions  ->  Modo desarrollador  ->  ID
REM  (p.ej. "abcdefghijklmnop1234567890abcdef")
REM ============================================================

if "%~1"=="" (
    echo [ERROR] Falta el ID de la extension.
    echo.
    echo Uso: install_host.bat ^<ID_EXTENSION^>
    echo Abre chrome://extensions, activa "Modo desarrollador" y copia el ID.
    exit /b 1
)

set EXT_ID=%~1
set HOST_NAME=com.operant.native_host
set SCRIPT_DIR=%~dp0
set MANIFEST_DIR=%APPDATA%\Operant
set MANIFEST_PATH=%MANIFEST_DIR%\operant_host.json
set SCRIPT_PATH=%SCRIPT_DIR%operant_host.py

REM --- Comprobar Python ---
set PY=
for %%P in (python py) do (
    %%P --version >nul 2>&1 && set PY=%%P
)
if not defined PY (
    echo [ERROR] No se encontro Python. Instalalo desde https://www.python.org/downloads/
    echo    Marca "Add python.exe to PATH" durante la instalacion.
    exit /b 1
)

if not exist "%MANIFEST_DIR%" mkdir "%MANIFEST_DIR%"

REM --- El host se ejecuta via un wrapper .bat estatico (operant_host.bat) ---
REM CRITICO: Chrome ejecuta el path del manifest tal cual. Si apuntara al .py,
REM Windows lo lanzaria con python.exe (consola) y apareceria una ventana negra
REM que roba el foco al navegador en cada conexion del host. El wrapper usa
REM pythonw.exe (sin consola) para que el host corra en silencio.
set WRAPPER_PATH=%SCRIPT_DIR%operant_host.bat

REM --- Generar el manifest JSON (apunta al wrapper, no al .py) ---
%PY% -c "import json; m={'name':r'%HOST_NAME%','description':'Operant native host (yt-dlp/ffmpeg)','path':r'%WRAPPER_PATH%','type':'stdio','allowed_origins':['chrome-extension://%EXT_ID%/']}; open(r'%MANIFEST_PATH%','w').write(json.dumps(m,indent=2))" || (
    echo [ERROR] No se pudo escribir el manifest del host.
    exit /b 1
)

REM --- Registrar en el registro de Windows (usuario actual) ---
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul

echo.
echo [OK] Host registrado para Chrome y Edge con ID: %EXT_ID%
echo.
echo Manifest: %MANIFEST_PATH%
echo Script:   %SCRIPT_PATH%
echo.
echo Siguientes pasos:
echo   1. Cierra y reabre Chrome/Edge y recarga la extension.
echo   2. Abre el panel -^> clic en el chip inferior "Herramientas".
echo      El host detecta/descarga automaticamente yt-dlp y ffmpeg a
echo      %%LOCALAPPDATA%%\Operant\bin (sin tocar el sistema), con progreso real.
echo   3. Cuando el chip muestre "yt-dlp 2026.x check", ya puedes usar el boton yt-dlp.
exit /b 0
