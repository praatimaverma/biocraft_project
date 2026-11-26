<#
 Installs the two daily BioCraft Tally sync tasks on THIS (client Tally) Windows Server.
   08:00 IST  -> task "BiocraftTallySync-Morning-0800IST"
   15:00 IST  -> task "BiocraftTallySync-Evening-1500IST"
 Run from an Administrator PowerShell:   .\install-schedule.ps1
 Or double-click install-schedule.bat (it asks for administrator rights).
 Safe to run again: it replaces the two tasks, nothing else.
#>
param(
  [string]$MorningIST = '08:00',
  [string]$EveningIST = '15:00'
)
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Please run this as Administrator (right-click PowerShell > Run as administrator).' }

$folder = $PSScriptRoot
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'Node.js was not found. Install Node.js LTS from https://nodejs.org then run this again.' }
$node = $nodeCmd.Source
$envFile = Join-Path $folder '.env'
if (-not (Test-Path $envFile)) { throw ".env is missing. Copy .env.example to .env in $folder and fill it in first." }
if (-not (Test-Path (Join-Path $folder 'agent.js'))) { throw "agent.js not found in $folder" }

# Only SYSTEM and Administrators may read the .env (it holds the Supabase secret).
& icacls.exe $envFile /inheritance:r /grant:r 'SYSTEM:(F)' 'Administrators:(F)' | Out-Null

# Task Scheduler uses THIS computer's clock. Convert the IST times to local time so the
# tasks fire at 08:00 / 15:00 India time even if the server is set to another time zone.
$ist = [TimeZoneInfo]::FindSystemTimeZoneById('India Standard Time')
$local = [TimeZoneInfo]::Local
function ToLocalTime([string]$hhmm) {
  $p = $hhmm.Split(':')
  $d = [datetime]::SpecifyKind((Get-Date -Hour ([int]$p[0]) -Minute ([int]$p[1]) -Second 0 -Millisecond 0), [DateTimeKind]::Unspecified)
  return [TimeZoneInfo]::ConvertTime($d, $ist, $local)
}
$jobs = @(
  @{ Name = 'BiocraftTallySync-Morning-0800IST'; At = (ToLocalTime $MorningIST) },
  @{ Name = 'BiocraftTallySync-Evening-1500IST'; At = (ToLocalTime $EveningIST) }
)

# Remove the old single-purpose tasks from the previous setup (09:00 / 21:00) so they do not also run.
foreach ($old in 'BiocraftTallySync-0900', 'BiocraftTallySync-2100') {
  if (Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $old -Confirm:$false
    Write-Host "Removed old task $old"
  }
}

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 55) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

foreach ($j in $jobs) {
  $action = New-ScheduledTaskAction -Execute $node -Argument 'agent.js --scheduled' -WorkingDirectory $folder
  $trigger = New-ScheduledTaskTrigger -Daily -At $j.At
  Register-ScheduledTask -TaskName $j.Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'BioCraft: full Tally -> Supabase invoice sync' -Force | Out-Null
  Write-Host ("Installed {0}: runs daily at {1:HH:mm} (this computer's time) = IST schedule" -f $j.Name, $j.At)
}

Write-Host ''
Write-Host "Node: $node"
Write-Host "Folder: $folder"
Write-Host 'Tasks survive Windows restarts. If the server was off at the scheduled time, the task runs when it is next available.'
Write-Host 'Test right now:        schtasks /Run /TN "BiocraftTallySync-Morning-0800IST"   (then read sync.log)'
Write-Host 'Check last sync:       run-check-last-sync.bat'
Get-ScheduledTask -TaskName 'BiocraftTallySync-*' | Get-ScheduledTaskInfo | Format-Table TaskName, NextRunTime, LastRunTime, LastTaskResult -AutoSize
