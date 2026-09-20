@echo off
REM Wrapper de Operant Native Host: lanza el .py con pythonw.exe sin consola.
REM IMPORTANTE: se invoca directamente (sin "start") para que el host herede
REM los stdin/stdout del pipe de Native Messaging. Sin esto, la comunicacion
REM con Chrome no funcionaria.
set SCRIPT=%~dp0operant_host.py

REM Buscar pythonw.exe: primero en el PATH, luego en rutas comunes de Windows.
set PY=
for %%P in (pythonw pyw python) do (
  %%P --version >nul 2>&1 && set PY=%%P
)
if not defined PY (
  for %%D in ("%LOCALAPPDATA%\Programs\Python\Python*\pythonw.exe" "C:\Python*\pythonw.exe") do (
    if exist "%%D" set PY="%%D"
  )
)
if not defined PY exit /b 1

"%PY%" "%SCRIPT%" %*
exit /b 0
