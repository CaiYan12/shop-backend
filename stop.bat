@echo off
setlocal
cd /d "%~dp0"
rem Stop the backend, then Elasticsearch; the two lifecycles are independent.
node scripts\stop.mjs
set "backendExit=%errorlevel%"
node scripts\es-stop.mjs
if not "%backendExit%"=="0" exit /b %backendExit%
endlocal
