@echo off
setlocal
cd /d "%~dp0"

where ruby >nul 2>nul
if errorlevel 1 (
  echo Ruby was not found. Installing Ruby + DevKit via winget...
  winget install --id RubyInstallerTeam.RubyWithDevKit.3.3 -e --accept-source-agreements --accept-package-agreements
  echo.
  echo Ruby is installed. CLOSE this window, open a new one, and run serve.bat again.
  pause
  exit /b 1
)

if not exist "Gemfile.lock" (
  echo First run - installing Jekyll, this takes a few minutes...
  call bundle install || goto :error
)

echo.
echo Serving http://127.0.0.1:4000   (press Ctrl+C to stop)
echo.
call bundle exec jekyll serve --livereload --baseurl "" --open-url
goto :eof

:error
echo.
echo bundle install failed. Check Ruby + DevKit are installed and try "ridk install" once.
pause
