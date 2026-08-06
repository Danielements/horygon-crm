param(
  [Parameter(Mandatory = $true)][string]$SubjectCode,
  [Parameter(Mandatory = $true)][string]$Organization,
  [Parameter(Mandatory = $true)][string]$Province,
  [string]$Locality = "",
  [string]$Country = "IT",
  [string]$OutputDir = ".\\tmp\\sdi-csr",
  [switch]$Der
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) {
  throw "OpenSSL non trovato nel PATH. Installa OpenSSL e riprova."
}

$subjectCodeClean = $SubjectCode.Trim()
if (-not $subjectCodeClean) {
  throw "SubjectCode obbligatorio. Usa il Codice Fiscale o il Codice da anteporre a SDI-."
}

$commonName = if ($subjectCodeClean.ToUpper().StartsWith("SDI-")) { $subjectCodeClean } else { "SDI-$subjectCodeClean" }

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$configPath = Join-Path $OutputDir "sdi-openssl.cnf"
$keyPath = Join-Path $OutputDir "sdi.key"
$csrPemPath = Join-Path $OutputDir "sdi.csr.pem"
$csrDerPath = Join-Path $OutputDir "sdi.csr.der"

$config = @"
[ req ]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = req_distinguished_name

[ req_distinguished_name ]
C = $Country
ST = $Province
L = $Locality
O = $Organization
CN = $commonName
"@

Set-Content -LiteralPath $configPath -Value $config -Encoding ascii

& openssl genrsa -out $keyPath 2048
& openssl req -new -key $keyPath -out $csrPemPath -config $configPath

if ($Der) {
  & openssl req -in $csrPemPath -outform der -out $csrDerPath
}

Write-Host ""
Write-Host "Creati:"
Write-Host "  Chiave: $keyPath"
Write-Host "  CSR PEM: $csrPemPath"
if ($Der) {
  Write-Host "  CSR DER: $csrDerPath"
}
Write-Host ""
Write-Host "Common Name usato: $commonName"
