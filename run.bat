@echo off
chcp 65001 >nul
title DibujoLiveShare
cd /d "%~dp0"

echo.
echo  ==============================================
echo    DibujoLiveShare - dibujo 3D colaborativo
echo  ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo  [ERROR] No se encontro Node.js. Instalalo desde https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo  No hay dependencias instaladas. Ejecutando install...
    echo.
    call install.bat
    if errorlevel 1 exit /b 1
)

if not exist "public\vendor\three.module.js" (
    echo  Preparando three.js en public\vendor...
    call node -e "const fs=require('fs'),p=require('path');const src=p.join('node_modules','three','build'),dst=p.join('public','vendor');fs.mkdirSync(dst,{recursive:true});for(const f of fs.readdirSync(src)){const s=p.join(src,f);if(fs.statSync(s).isFile())fs.copyFileSync(s,p.join(dst,f))}console.log('      ok');"
)

echo  Arrancando el servidor...
echo  El link local y el de la red (para los demas) aparecen abajo.
echo  Deja esta ventana abierta mientras usas la app (Ctrl+C para salir).
echo.

call node server.js

echo.
echo  ==============================================
echo    El servidor se cerro.
echo  ==============================================
echo.
pause
