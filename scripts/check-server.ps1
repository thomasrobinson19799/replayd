$ErrorActionPreference = 'Stop'
$env:REPLAYD_TEST_DATABASE_URL = 'postgres://replayd:replayd@127.0.0.1:55432/replayd?sslmode=disable'
$env:CARGO_INCREMENTAL = '0'
Set-Location (Join-Path $PSScriptRoot '../server')
rtk proxy cargo fmt --check
if ($LASTEXITCODE) { exit $LASTEXITCODE }
rtk proxy cargo clippy --all-targets -- -D warnings
if ($LASTEXITCODE) { exit $LASTEXITCODE }
rtk proxy cargo test
exit $LASTEXITCODE
