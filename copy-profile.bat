@echo off
REM ============================================================
REM Run this ONCE (and again any time you want to refresh the
REM automation profile from your real one). Close Chrome fully
REM before running this.
REM
REM EDIT THESE TWO LINES to match your machine first:
REM   SOURCE = your real Chrome "User Data" folder
REM   DEST   = a NEW folder outside the default Chrome install
REM            location (this is required — Chrome refuses CDP
REM            debugging on its default profile path no matter
REM            which --profile-directory you pass)
REM ============================================================

set SOURCE=C:\Users\Lenovo\AppData\Local\Google\Chrome\User Data
set DEST=C:\ChromeAutomation
set PROFILE_FOLDER=Profile 39

echo Copying %SOURCE% to %DEST% ...
echo (This includes "Local State" from the User Data root, which
echo  Chrome needs to recognize %PROFILE_FOLDER% as a real profile.)

robocopy "%SOURCE%" "%DEST%" /E ^
  /XD "%PROFILE_FOLDER%\Cache" "%PROFILE_FOLDER%\Code Cache" "%PROFILE_FOLDER%\GPUCache" "%PROFILE_FOLDER%\Service Worker\CacheStorage" ^
  /XF "lockfile" "LOCK" "SingletonLock" "SingletonCookie" "SingletonSocket"

echo.
echo Done. Copied to %DEST%
echo Next: run launch-chrome.bat
pause
