@echo off
rem Start the DSH phone push notifier as a background (pythonw) process.
rem Uses %~dp0 so it works no matter where this folder is placed.
rem NOTE: launched from Task Scheduler this flashes a console window and the
rem `pyw -3` launcher may be absent from the scheduler PATH. For a windowless
rem autostart, register pythonw.exe directly as a hidden task — see README.md.
start "" pyw -3 "%~dp0dsh_push.py"
