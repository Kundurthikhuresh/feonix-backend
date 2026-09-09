@echo off
:loop
call npm run dev
echo [run-forever] backend exited, restarting in 2s...
timeout /t 2 /nobreak >nul
goto loop
