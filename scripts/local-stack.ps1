$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$env:REPLAYD_SITE_PROXIES = '172.30.53.1'
$env:REPLAYD_TELEGRAM_API = 'http://host.docker.internal:18099'
rtk proxy docker compose -f deploy/docker-compose.yml --profile app up -d --no-build --wait
exit $LASTEXITCODE
