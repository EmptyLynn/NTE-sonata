@echo off
chcp 65001 > nul
echo ============================================
echo   清理电脑管家卸载残留 TFSPEQService
echo ============================================
echo.
echo 该残留服务正在干扰新启动的程序（导致崩溃）。
echo 即将：停止并删除服务 TFSPEQService，删除 C:\Windows\TFSPEQService.exe
echo.
net stop TFSPEQService 2>nul
sc config TFSPEQService start= disabled 2>nul
sc delete TFSPEQService 2>nul
del /f /q "C:\Windows\TFSPEQService.exe" 2>nul
echo 清理完成。状态：
sc query TFSPEQService 2>&1 | findstr STATE
if exist "C:\Windows\TFSPEQService.exe" (echo 文件仍在) else (echo 文件已删除)
echo DONE > "D:\JOY\异环钢琴模拟器Zcode\tfs-cleanup-done.txt"
echo.
echo 按任意键关闭窗口
pause > nul
