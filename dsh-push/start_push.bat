@echo off
rem Start the DSH phone push notifier as a background (pythonw) process.
rem Uses %~dp0 so it works no matter where this folder is placed.
start "" pyw -3 "%~dp0dsh_push.py"
