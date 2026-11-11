param([string]$Configuration = 'Release')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:DOTNET_CLI_HOME = Join-Path $PSScriptRoot '.cli'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$sdk = if (Test-Path '.dotnet\dotnet.exe') { Join-Path $PSScriptRoot '.dotnet\dotnet.exe' } else { 'dotnet' }
& $sdk restore Horygon.sln
if ($LASTEXITCODE -ne 0) { throw 'Restore non riuscito.' }
& $sdk build Horygon.sln -c $Configuration --no-restore
if ($LASTEXITCODE -ne 0) { throw 'Build non riuscita.' }
& $sdk test Horygon.Tests/Horygon.Tests.csproj -c $Configuration --no-build --logger 'trx;LogFileName=horygon.trx' --results-directory artifacts/TestResults
if ($LASTEXITCODE -ne 0) { throw 'Test non riusciti.' }
