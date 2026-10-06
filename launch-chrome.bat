@echo off
REM ============================================================
REM Run this every time before running the discover or generate
REM scripts. It opens a real Chrome window using the COPIED
REM profile (from copy-profile.bat), with remote debugging on,
REM so the extension and your login are already there.
REM
REM Make sure this DEST/PROFILE_FOLDER match what you used in
REM copy-profile.bat.
REM ============================================================

set DEST=C:\ChromeAutomation\User Data
set PROFILE_FOLDER=Profile 39

"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%DEST%" ^
  --profile-directory="%PROFILE_FOLDER%"
