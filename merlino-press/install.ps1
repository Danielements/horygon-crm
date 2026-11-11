# Installazione per l'utente corrente; non richiede privilegi amministrativi.
$ErrorActionPreference = 'Stop'
if (-not (Test-Path (Join-Path $PSScriptRoot 'Horygon.Desktop.exe'))) { throw 'Eseguire questo script dalla cartella del pacchetto pubblicato.' }
$destination = Join-Path $env:LOCALAPPDATA 'Programs\Horygon\0.8.1'
if (Get-Process Horygon.Desktop -ErrorAction SilentlyContinue) { throw 'Chiudere Horygon prima di installare.' }
New-Item -ItemType Directory -Force $destination | Out-Null
Get-ChildItem -LiteralPath $PSScriptRoot | Copy-Item -Destination $destination -Recurse -Force
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Horygon.lnk'))
$shortcut.TargetPath = Join-Path $destination 'Horygon.Desktop.exe'
$shortcut.WorkingDirectory = $destination
$shortcut.Save()
Write-Host "Horygon installato in $destination. Avvialo dal menu Start."


