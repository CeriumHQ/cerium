@echo off
"%~dp0..\runtime\node.exe" "%~dp0standalone.mjs" %*
exit /b %errorlevel%
