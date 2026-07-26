param(
  [int]$Port = $(if ($env:CONTROL_PORT) { [int]$env:CONTROL_PORT } else { 8787 }),
  [switch]$ReplaceExisting
)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$url = "http://127.0.0.1:$Port/"

function Test-ControlConsole {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
    return $response.StatusCode -eq 200 -and $response.Content -match 'id="root"'
  } catch {
    return $false
  }
}

function Get-ChildProcesses([int]$ParentId) {
  return @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId" -ErrorAction SilentlyContinue)
}

function Stop-ProcessTree([int]$ProcessId) {
  foreach ($child in Get-ChildProcesses $ProcessId) {
    Stop-ProcessTree ([int]$child.ProcessId)
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
  Select-Object -First 1

if (-not $listener) {
  exit 10
}

$owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
$children = if ($owner) { Get-ChildProcesses ([int]$owner.ProcessId) } else { @() }
$normalizedRoot = $root.TrimEnd('\')
$belongsToProject = $owner -and (
  $owner.CommandLine -match '(?i)(^|\s)run\.cjs(\s|$)' -or
  @($children | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($normalizedRoot) }).Count -gt 0
)

if (-not $belongsToProject) {
  Write-Host "Port $Port is occupied by a process that was not started by this project (PID $($listener.OwningProcess))."
  exit 20
}

if ((Test-ControlConsole) -and -not $ReplaceExisting) {
  Write-Host "Control console is already running: $url"
  Start-Process $url
  exit 0
}

if ($ReplaceExisting) {
  Write-Host "Stopping the existing project process tree (PID $($listener.OwningProcess))..."
} else {
  Write-Host "Restarting unresponsive control console (PID $($listener.OwningProcess))..."
}
Stop-ProcessTree ([int]$listener.OwningProcess)
$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  Start-Sleep -Milliseconds 200
  $stillListening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
} while ($stillListening -and [DateTime]::UtcNow -lt $deadline)

if ($stillListening) {
  Write-Host "Port $Port did not become available after stopping the stale project process."
  exit 21
}

exit 10
