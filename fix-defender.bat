@echo off
echo ============================================
echo   异环钢琴模拟器 - Defender 白名单修复
echo ============================================
echo.
echo 需要管理员权限来添加 Windows Defender 排除项
echo （否则 Windows 会拦截模拟器的按键模拟）
echo.
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -Command Add-MpPreference -ExclusionPath \"D:\JOY\异环钢琴模拟器Zcode\"; Add-MpPreference -ExclusionPath \"D:\JOY\异环钢琴模拟器Zcode\dist12\win-unpacked\"; Write-Host 完成; Start-Sleep 3'"
echo.
echo 如果 UAC 弹窗点了「是」，白名单已添加成功。
echo 现在可以直接运行 dist12\win-unpacked\异环钢琴模拟器.exe
echo.
pause
