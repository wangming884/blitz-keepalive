#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the blitz.cloud keep-alive agent so it starts automatically on Windows.

.DESCRIPTION
    Target mode:
      default          starts the management console with zero targets. Open
                       /admin and add the URLs that should be kept awake.
      -Url             starts with one CLI target (advanced/automation use).
      -Config          starts with a multi-target JSON file (advanced use).

    Startup mode:
      default          registers a scheduled task (needs an elevated PowerShell,
                       survives logoff, can run as SYSTEM with -RunAsSystem)
      -StartupFolder   drops a hidden launcher into the current user's Startup
                       folder (no admin rights needed, starts at logon)

.EXAMPLE
    .\install-task.ps1

.EXAMPLE
    .\install-task.ps1 -Url https://app.yourname.blitz.cloud -Expect "Dashboard"

.EXAMPLE
    .\install-task.ps1 -Config config.json

.EXAMPLE
    .\install-task.ps1 -StartupFolder
#>
[CmdletBinding()]
param(
    [string]$Url = "",

    [string]$Config = "",

    [string]$Expect = "",

    [ValidateRange(1, 29)]
    [int]$IntervalMin = 20,

    [ValidateRange(1, 65535)]
    [int]$Port = 8080,

    [string]$TaskName = "BlitzKeepAlive",

    [string]$NodePath = (Get-Command node -ErrorAction Stop).Source,

    [switch]$RunAsSystem,

    [switch]$StartupFolder
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path $projectRoot "keepalive.mjs"
$envPath = Join-Path $projectRoot ".env"
$isSingleTarget = -not [string]::IsNullOrWhiteSpace($Url)
$isMultiTarget = -not [string]::IsNullOrWhiteSpace($Config)

if ($isSingleTarget -and $isMultiTarget) {
    throw "Use only one of -Url (one app) or -Config (many apps). Omit both to add targets from /admin."
}
if ($isMultiTarget) {
    if (-not [System.IO.Path]::IsPathRooted($Config)) {
        $Config = Join-Path $projectRoot $Config
    }
    if (-not (Test-Path $Config)) { throw "Config file not found: $Config" }
}

if (-not (Test-Path $scriptPath)) {
    throw "keepalive.mjs not found in $projectRoot"
}
if (-not (Test-Path (Join-Path $projectRoot "node_modules\puppeteer-core"))) {
    throw "Dependencies missing. Run 'npm install' in $projectRoot first."
}
if (-not (Test-Path $envPath)) {
    Copy-Item (Join-Path $projectRoot ".env.example") $envPath
}

# Rewrite only the keys we manage; keep comments and unrelated keys untouched.
# Target addresses are deliberately passed as CLI arguments, never written to
# the environment. In multi mode the interval belongs to each target in the
# JSON file, so the global override is cleared instead of silently beating the
# config defaults.
$managed = [ordered]@{}
if ($isMultiTarget) {
    $managed['INTERVAL_MIN'] = ''
}
else {
    $managed['INTERVAL_MIN'] = $IntervalMin
}
$managed['PORT'] = $Port
$obsoleteTargetKeys = @(('BLITZ' + '_URL'), ('CONFIG' + '_FILE'), ('EXPECT' + '_TEXT'))
$result = New-Object System.Collections.Generic.List[string]
$seen = @{}
foreach ($line in (Get-Content $envPath)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
        $key = $matches[1]
        if ($obsoleteTargetKeys -contains $key) { continue }
        if ($managed.Contains($key)) {
            $result.Add("$key=$($managed[$key])")
            $seen[$key] = $true
            continue
        }
    }
    $result.Add($line)
}
foreach ($key in $managed.Keys) {
    if (-not $seen.ContainsKey($key)) { $result.Add("$key=$($managed[$key])") }
}
# UTF-8 without BOM: Node's --env-file parser does not strip a BOM.
[System.IO.File]::WriteAllLines($envPath, $result, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Configuration written to $envPath"

function ConvertTo-CommandLineValue([string]$Value) {
    return '"' + ($Value -replace '"', '\"') + '"'
}

$targetArgs = @()
if ($isSingleTarget) {
    $targetArgs += "--url=$(ConvertTo-CommandLineValue $Url)"
    if (-not [string]::IsNullOrWhiteSpace($Expect)) {
        $targetArgs += "--expect=$(ConvertTo-CommandLineValue $Expect)"
    }
}
elseif ($isMultiTarget) {
    $targetArgs += "--config=$(ConvertTo-CommandLineValue $Config)"
}
$baseArgs = @('--env-file=.env', 'keepalive.mjs') + $targetArgs
$argumentText = $baseArgs -join ' '

if ($StartupFolder) {
    # Hidden per-user launcher. Useful when Task Scheduler registration is not
    # permitted (non-elevated shell, locked-down machine).
    $startup = [Environment]::GetFolderPath('Startup')
    $vbsPath = Join-Path $startup "$TaskName.vbs"
    $vbsCommand = '"' + $NodePath + '" ' + $argumentText
    $vbsCommandEscaped = $vbsCommand.Replace('"', '""')
    $vbsRootEscaped = $projectRoot.Replace('"', '""')
    $vbsLines = @(
        'Set sh = CreateObject("WScript.Shell")'
        'sh.CurrentDirectory = "__ROOT__"'
        'sh.Run "__COMMAND__", 0, False'
    )
    $template = $vbsLines -join "`r`n"
    $vbs = $template.Replace('__ROOT__', $vbsRootEscaped).Replace('__COMMAND__', $vbsCommandEscaped)
    # UTF-16: Windows Script Host needs it to handle non-ASCII paths.
    [System.IO.File]::WriteAllText($vbsPath, $vbs, [System.Text.Encoding]::Unicode)

    Start-Process -FilePath $NodePath -ArgumentList $argumentText -WorkingDirectory $projectRoot -WindowStyle Hidden
    Write-Host "Startup launcher installed: $vbsPath"
    Write-Host "It starts hidden at every logon; the agent is running now."
    Write-Host "Management console: http://127.0.0.1:$Port/admin"
    Write-Host "Check logs: Get-Content '$projectRoot\logs\keepalive.log' -Tail 20"
    return
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    throw @"
Registering a scheduled task requires an elevated PowerShell.
Options:
  1. Re-run this script from an Administrator PowerShell, or
  2. Use -StartupFolder to install a per-user launcher without admin rights.
"@
}

$action = New-ScheduledTaskAction `
    -Execute $NodePath `
    -Argument $argumentText `
    -WorkingDirectory $projectRoot

$trigger = if ($RunAsSystem) {
    New-ScheduledTaskTrigger -AtStartup
}
else {
    New-ScheduledTaskTrigger -AtLogOn
}

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

if ($RunAsSystem) {
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
}
else {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
}

Start-ScheduledTask -TaskName $TaskName
Write-Host "Task '$TaskName' registered and started."
Write-Host "Management console: http://127.0.0.1:$Port/admin"
Write-Host "Check status:  Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "Check logs:    Get-Content '$projectRoot\logs\keepalive.log' -Tail 20"
