@echo off
setlocal
cd /d "%~dp0"
rem Start Elasticsearch first; a failure here must not block the backend (C47).
node scripts\es-dev.mjs
node scripts\dev.mjs
endlocal
