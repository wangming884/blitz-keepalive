#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$TaskName = "BlitzKeepAlive"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item (Join-Path $projectRoot "keepalive.lock") -ErrorAction SilentlyContinue

Write-Host "Task '$TaskName' removed."
