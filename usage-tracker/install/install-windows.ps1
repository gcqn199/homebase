# Windows: starts the collector at every logon, hidden in the background.
# Run once from PowerShell, inside this folder:
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
$collector = (Resolve-Path "$PSScriptRoot\..\collector\collector.mjs").Path
$node = (Get-Command node -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -Command `"& '$node' '$collector'`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "AI Usage Collector" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "AI Usage Collector"
Write-Host "Installed and started. To remove: Unregister-ScheduledTask -TaskName 'AI Usage Collector'"
