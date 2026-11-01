@echo off
rem Asks about each downloadable part (engine, Whisper, image tools, models) and downloads what you pick.
title LLM Icarus - Download components
"%~dp0runtime\node.exe" "%~dp0server\setup.js" --interactive
echo.
pause
