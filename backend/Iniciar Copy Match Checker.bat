@echo off
title Copy Match Checker
cd /d "%~dp0"
echo ============================================================
echo   Copy Match Checker - iniciando...
echo.
echo   Se abrira tu navegador en:  http://localhost:5500
echo   Manten esta ventana abierta mientras usas la herramienta.
echo   Para detener: cierra esta ventana o presiona Ctrl+C.
echo ============================================================
echo.

REM Abre el navegador 2 segundos despues (cuando el servidor ya esta listo)
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:5500'"

REM Arranca el servidor (sirve la pagina + fetch sin CORS)
py serve.py

echo.
echo El servidor se detuvo. Presiona una tecla para cerrar.
pause >nul
