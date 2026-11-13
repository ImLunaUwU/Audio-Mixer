#!/bin/bash
# Cross-compiles native/app-router/AppRouter.cpp into bin/AppRouter.exe with clang-cl and an
# xwin splat of the Windows SDK + MSVC CRT. On Windows use native/app-router/build.cmd instead.
#   XWIN=/path/to/xwin/splat scripts/build-native.sh
set -euo pipefail
cd "$(dirname "$0")/.."
XWIN="${XWIN:?set XWIN to an xwin splat directory (contains crt/ and sdk/)}"
mkdir -p bin
clang-cl --target=x86_64-pc-windows-msvc /nologo /O2 /MT /EHsc /std:c++17 /DUNICODE /D_UNICODE \
  -fuse-ld=lld-link \
  /imsvc "$XWIN/crt/include" /imsvc "$XWIN/sdk/include/ucrt" /imsvc "$XWIN/sdk/include/um" \
  /imsvc "$XWIN/sdk/include/shared" /imsvc "$XWIN/sdk/include/winrt" \
  native/app-router/AppRouter.cpp /Fobin/AppRouter.obj /Febin/AppRouter.exe \
  /link /SUBSYSTEM:CONSOLE "/LIBPATH:$XWIN/crt/lib/x86_64" "/LIBPATH:$XWIN/sdk/lib/um/x86_64" \
  "/LIBPATH:$XWIN/sdk/lib/ucrt/x86_64" ole32.lib runtimeobject.lib
rm -f bin/AppRouter.obj
echo "built bin/AppRouter.exe"
