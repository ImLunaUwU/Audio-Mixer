@echo off
rem Build AppRouter.exe from a "x64 Native Tools Command Prompt for VS".
cd /d "%~dp0..\.."
if not exist bin mkdir bin
cl /nologo /O2 /MT /EHsc /std:c++17 /DUNICODE /D_UNICODE native\app-router\AppRouter.cpp /Fobin\AppRouter.obj /Febin\AppRouter.exe /link /SUBSYSTEM:CONSOLE ole32.lib runtimeobject.lib
del bin\AppRouter.obj
