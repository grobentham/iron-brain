$ErrorActionPreference = 'SilentlyContinue'

$InstallRoot = Join-Path $env:LOCALAPPDATA 'ICTBrain\Engine'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'ICTBrainLocalEngine'

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*ICTBrain*local-engine*server.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Remove-ItemProperty -Path $RunKey -Name $RunName -Force
if (Test-Path $InstallRoot) { Remove-Item $InstallRoot -Recurse -Force }

Write-Host 'ICT Brain Local Engine has been removed from Windows startup.' -ForegroundColor Green
Write-Host 'Logs under %LOCALAPPDATA%\ICTBrain\logs are intentionally kept for diagnostics.'
