param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not $SkipTests) { & "$PSScriptRoot\build.ps1" }
$env:DOTNET_CLI_HOME = Join-Path $PSScriptRoot '.cli'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$sdk = if (Test-Path '.dotnet\dotnet.exe') { Join-Path $PSScriptRoot '.dotnet\dotnet.exe' } else { 'dotnet' }
& $sdk publish Horygon.Desktop/Horygon.Desktop.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -o artifacts/Horygon-0.8.2-win-x64
if ($LASTEXITCODE -ne 0) { throw 'Publish non riuscito.' }
Copy-Item README.md,SECURITY.md,PROJECT_STATUS.md,install.ps1 -Destination artifacts/Horygon-0.8.2-win-x64
Compress-Archive -Path artifacts/Horygon-0.8.2-win-x64 -DestinationPath artifacts/Horygon-0.8.2-win-x64.zip -Force
Write-Host 'Pacchetto: artifacts/Horygon-0.8.2-win-x64.zip'


