@echo off
cd /d "%~dp0"
call npm run start:holohangout
if errorlevel 1 (
  echo.
  echo HoloHangout stopped with an error. Run "npm run check" for details.
  pause
)
