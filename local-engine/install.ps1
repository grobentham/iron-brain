$ErrorActionPreference = 'Stop'

$PackageRoot = Split-Path -Parent $PSScriptRoot
$InstallRoot = Join-Path $env:LOCALAPPDATA 'ICTBrain\Engine'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'ICTBrainLocalEngine'
$NodeSource = Join-Path $PackageRoot 'runtime\node.exe'

Write-Host 'Installing ICT Brain Local Engine...'

if (-not (Test-Path $NodeSource)) {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) {
    throw 'Portable node.exe was not found and Node.js is not installed. Download the Windows Local Engine artifact from the ICT Brain GitHub Actions run.'
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $PackageRoot 'runtime') | Out-Null
  Copy-Item $node.Source $NodeSource -Force
}

# Stop an older installed ICT Brain engine before replacing its files.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*ICTBrain*local-engine*server.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

$copyItems = @('runtime', 'node_modules', 'vercel-app', 'local-engine', 'package.json')
foreach ($item in $copyItems) {
  $src = Join-Path $PackageRoot $item
  if (-not (Test-Path $src)) { throw "Required package item is missing: $item" }
  $dst = Join-Path $InstallRoot $item
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $src $dst -Recurse -Force
}

$Launcher = Join-Path $InstallRoot 'local-engine\launcher.vbs'
$RunValue = 'wscript.exe "' + $Launcher + '"'
New-Item -Path $RunKey -Force | Out-Null
New-ItemProperty -Path $RunKey -Name $RunName -Value $RunValue -PropertyType String -Force | Out-Null

Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $Launcher + '"') -WindowStyle Hidden

$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -Method Get -TimeoutSec 2
    if ($health.ok) { $ready = $true; break }
  } catch {}
}

if (-not $ready) {
  throw 'ICT Brain was installed, but the local engine did not answer on 127.0.0.1:8787. Check %LOCALAPPDATA%\ICTBrain\logs\engine.log.'
}

Write-Host ''
Write-Host 'ICT Brain Local Engine installed successfully.' -ForegroundColor Green
Write-Host 'It now starts automatically when you sign in to Windows.'
Write-Host 'Local endpoint: http://127.0.0.1:8787'
Write-Host 'You do not need to run a BAT file.'
