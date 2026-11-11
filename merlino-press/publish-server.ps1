param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:DOTNET_CLI_HOME = Join-Path $PSScriptRoot '.cli'
$sdk = Join-Path $PSScriptRoot '.dotnet\dotnet.exe'
if (-not $SkipTests) { & "$PSScriptRoot\build.ps1" }
& $sdk publish Horygon.Server/Horygon.Server.csproj -c Release -o artifacts/Horygon-Server-0.9.0-portable --self-contained false
if ($LASTEXITCODE -ne 0) { throw 'Pubblicazione server non riuscita.' }
& $sdk publish Horygon.Migrate/Horygon.Migrate.csproj -c Release -r win-x64 --self-contained true -o artifacts/Horygon-Migrate-0.9.0-win-x64
if ($LASTEXITCODE -ne 0) { throw 'Pubblicazione migrazione non riuscita.' }
Copy-Item SERVER_SETUP.md -Destination artifacts/Horygon-Server-0.9.0-portable
Compress-Archive -Path artifacts/Horygon-Server-0.9.0-portable -DestinationPath artifacts/Merlino-press-Server-0.9.0-portable.zip -Force
Compress-Archive -Path artifacts/Horygon-Migrate-0.9.0-win-x64 -DestinationPath artifacts/Merlino-press-Migrate-0.9.0-win-x64.zip -Force
python deploy/package.py
if ($LASTEXITCODE -ne 0) { throw 'Pacchetto sorgente non riuscito.' }
