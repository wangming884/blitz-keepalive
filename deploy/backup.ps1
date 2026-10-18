[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path (Get-Location) 'data'),
  [string]$OutputDir = (Join-Path (Get-Location) 'backups')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$requiredFiles = @(
  'managed-targets.json',
  'target-secrets.key',
  'admin-auth.json'
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

# The archive contains the encryption key and password hash. Restrict access
# where the host supports Windows ACLs; a warning is preferable to hiding a
# hardening failure while still preserving the backup.
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $archivePath /inheritance:r /grant:r "$($identity):F" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "icacls exited with code $LASTEXITCODE"
  }
} catch {
  Write-Warning "Could not restrict archive ACL: $($_.Exception.Message)"
}

Write-Output "Backup created: $archivePath"
Write-Output "Included files: $($files.Count)"
Write-Output 'Store this archive as a secret. Restore it together with the matching application version.'
