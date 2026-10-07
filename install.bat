@echo off
chcp 65001 >nul
title DibujoLiveShare - Instalacion
cd /d "%~dp0"

echo.
echo  ==============================================
echo    DibujoLiveShare - Instalacion
echo  ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo  [ERROR] No se encontro Node.js.
    echo          Descargalo de https://nodejs.org ^(LTS^), instalalo y volve a ejecutar.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
echo  Node.js detectado: %NODEV%
echo.

echo  [1/2] Instalando dependencias (express, socket.io, three)...
echo        Puede tardar un rato la primera vez.
echo.
call npm install
if errorlevel 1 (
    echo.
    echo  [ERROR] Fallo npm install. Revisa tu conexion a internet e intentalo de nuevo.
    echo.
    pause
    exit /b 1
)

echo.
echo  [2/2] Preparando el frontend (three.js en public\vendor)...
call node -e "const fs=require('fs'),p=require('path');const src=p.join('node_modules','three','build'),dst=p.join('public','vendor');if(!fs.existsSync(src)){console.error('[ERROR] falta node_modules/three');process.exit(1)}fs.mkdirSync(dst,{recursive:true});for(const f of fs.readdirSync(src)){const s=p.join(src,f);if(fs.statSync(s).isFile())fs.copyFileSync(s,p.join(dst,f))}console.log('      three.js copiado a public/vendor');"
if errorlevel 1 (
    echo.
    echo  [ERROR] No se pudo preparar three.js.
    echo.
    pause
    exit /b 1
)

if not exist "public\vendor\three.module.js" (
    echo  [ERROR] Falta public\vendor\three.module.js
    echo.
    pause
    exit /b 1
)

echo.
echo  ==============================================
echo    Listo! Ahora ejecuta  run.bat  para arrancar
echo  ==============================================
echo.
pause
