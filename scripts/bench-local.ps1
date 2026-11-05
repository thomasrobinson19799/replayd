param([ValidateSet('replay','compare')][string]$Suite = 'replay')
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$env:RATES = '1,4'
$env:REPEAT = '3'
$env:SECONDS = '15'
$env:SCENARIOS = 'terminal-1000'
$env:CATS = 'devtools.timeline,disabled-by-default-devtools.timeline'
$env:NO_BUILD = '1'
$env:PLAYWRIGHT_CHANNEL = 'chrome'
rtk proxy node "sdk/bench/perf/$Suite.mjs"
exit $LASTEXITCODE
