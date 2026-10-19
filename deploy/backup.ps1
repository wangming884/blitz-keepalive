[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path (Get-Location) 'data'),
  [string]$OutputDir = (Join-Path (Get-Location) 'backups'),
  [string]$PassphraseFile = '',
  [switch]$AllowPlaintext
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$requiredFiles = @(
  'managed-targets.json',
  'target-secrets.key',
  'admin-auth.json',
  'runtime-state.json',
  'stats.json'
)

$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
if (-not (Test-Path -LiteralPath $resolvedDataDir -PathType Container)) {
  throw "Data directory does not exist: $resolvedDataDir"
}

$resolvedOutputDir = [System.IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null

$files = [System.Collections.Generic.List[string]]::new()
foreach ($name in $requiredFiles) {
  $candidate = Join-Path $resolvedDataDir $name
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    $item = Get-Item -LiteralPath $candidate
    if ($item.Length -lt 0) {
      throw "Could not read backup file: $candidate"
    }
    $files.Add($candidate)
  } else {
    Write-Warning "Optional backup file is missing: $candidate"
  }
}

if ($files.Count -eq 0) {
  throw "No backup files were found in $resolvedDataDir"
}

$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$archivePath = Join-Path $resolvedOutputDir "blitz-keepalive-backup-$timestamp.zip"
Compress-Archive -LiteralPath $files.ToArray() -DestinationPath $archivePath -CompressionLevel Optimal

$cryptoScript = Join-Path $PSScriptRoot 'backup-crypto.mjs'
if (-not (Test-Path -LiteralPath $cryptoScript -PathType Leaf)) {
  throw "Backup encryption helper does not exist: $cryptoScript"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is required to encrypt the backup archive.'
}

$cryptoArgs = @('encrypt', $archivePath)
if ($PassphraseFile) {
  $resolvedPassphraseFile = [System.IO.Path]::GetFullPath($PassphraseFile)
  if (-not (Test-Path -LiteralPath $resolvedPassphraseFile -PathType Leaf)) {
    throw "Passphrase file does not exist: $resolvedPassphraseFile"
  }
  $cryptoArgs += @('--passphrase-file', $resolvedPassphraseFile)
}
if ($AllowPlaintext) {
  $cryptoArgs += '--allow-plaintext'
}

& node $cryptoScript @cryptoArgs
if ($LASTEXITCODE -ne 0) {
  throw "Backup encryption failed with exit code $LASTEXITCODE. The plaintext archive was kept at $archivePath."
}

$encryptedPath = "$archivePath.enc"
if (-not (Test-Path -LiteralPath $encryptedPath -PathType Leaf)) {
  throw "Backup encryption completed without producing $encryptedPath"
}

# The archive contains the target password key and the admin password hash.
# Restrict both the encrypted result and any explicitly retained plaintext.
$artifacts = @($encryptedPath)
if ($AllowPlaintext) {
  $artifacts += $archivePath
}
foreach ($artifact in $artifacts) {
  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $artifact /inheritance:r /grant:r "$($identity):F" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "icacls exited with code $LASTEXITCODE"
    }
  } catch {
    Write-Warning "Could not restrict archive ACL: $($_.Exception.Message)"
  }
}

Write-Output "Encrypted backup created: $encryptedPath"
Write-Output "Included files: $($files.Count)"
Write-Output 'Store this archive and the passphrase separately as secrets.'
Write-Output "Decrypt with: node deploy/backup-crypto.mjs decrypt `"$encryptedPath`""

# icacls is intentionally best-effort. Clear its native exit code so callers that
# inspect $LASTEXITCODE do not report a successfully created backup as failed.
$global:LASTEXITCODE = 0
