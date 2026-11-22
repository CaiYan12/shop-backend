@echo off
if not "%ES_LIFECYCLE_MARKER%"=="" echo started>"%ES_LIFECYCLE_MARKER%"
if not "%ES_LIFECYCLE_TOKEN%"=="" (
  powershell -NoProfile -Command "$env:ES_LIFECYCLE_TOKEN='%ES_LIFECYCLE_TOKEN%'; Start-Sleep -Seconds 120"
) else (
  powershell -NoProfile -Command "Start-Sleep -Seconds 120"
)
