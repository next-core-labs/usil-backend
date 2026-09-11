# Pushes Moyasar keys from this machine's .env.local to the live SCCC app.
# PowerShell only (not Git Bash). Never prints keys.
# From the project folder:
#   .\scripts\enable-moyasar-sccc.ps1

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$EnvFile = ".env.local"
$SshKey = Join-Path $HOME ".ssh\sccc_usil_deploy"
$Remote = "root@8.213.85.166"
$WebhookUrl = "https://hooks.usil.app/api/payments/webhook"

function Read-DotEnv([string]$Path) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.TrimEnd()
    if (-not $line -or $line.StartsWith("#") -or $line.IndexOf("=") -lt 1) { return }
    $i = $line.IndexOf("=")
    $k = $line.Substring(0, $i).Trim()
    $v = $line.Substring($i + 1)
    $map[$k] = $v
  }
  return $map
}

function Read-Secret([string]$Prompt) {
  try {
    Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null
    $typed = [Microsoft.VisualBasic.Interaction]::InputBox($Prompt, "Usil", "")
    if ($typed) { return [string]$typed }
  } catch {
  }
  Write-Host "Paste the value then press Enter. It is visible once."
  return [string](Read-Host "value")
}

if (-not (Test-Path -LiteralPath $SshKey)) {
  Write-Host "SSH key missing: $SshKey"
  exit 1
}

$map = Read-DotEnv $EnvFile
$secret = ""
foreach ($name in @("MOYASAR_SECRET_KEY", "PAYMENT_PROVIDER_SECRET_KEY", "MOYASAR_API_KEY")) {
  if ($map.ContainsKey($name) -and $map[$name]) {
    $secret = [string]$map[$name]
    break
  }
}

if ($secret -notmatch '^sk_(test|live)_[A-Za-z0-9]{24,}$' -or $secret.Contains('*')) {
  $secret = (Read-Secret "Paste Moyasar Secret Key (sk_live_ or sk_test_, eye icon, no stars)").Trim().Trim('"').Trim("'")
}

if ($secret -notmatch '^sk_(test|live)_[A-Za-z0-9]{24,}$' -or $secret.Contains('*')) {
  Write-Host "Key is incomplete, starred, or pk_. Open Moyasar, click the eye next to Secret Key, copy sk_."
  exit 1
}

$publishable = ""
if ($map.ContainsKey("MOYASAR_PUBLISHABLE_KEY") -and $map["MOYASAR_PUBLISHABLE_KEY"]) {
  $candidate = [string]$map["MOYASAR_PUBLISHABLE_KEY"]
  if ($candidate -match '^pk_(test|live)_' -and $candidate.Length -ge 40) {
    $publishable = $candidate
  }
}

$ssh = @(
  "-i", $SshKey,
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new"
)

$payload = @{ secret = $secret; publishable = $publishable } | ConvertTo-Json -Compress
$payloadPath = Join-Path $env:TEMP "usil-moyasar-payload.json"
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($payloadPath, $payload, $utf8)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$mergePy = Join-Path $scriptDir "merge-moyasar-env.py"
$registerPy = Join-Path $scriptDir "register-moyasar-webhook.py"
if (-not (Test-Path -LiteralPath $mergePy)) {
  Write-Host "Missing scripts\merge-moyasar-env.py"
  exit 1
}

Write-Host "Uploading Moyasar keys to usil.app (values are not printed)..."
& scp @ssh $payloadPath "${Remote}:/tmp/usil-moyasar-payload.json"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& scp @ssh $mergePy "${Remote}:/tmp/merge-moyasar-env.py"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (Test-Path -LiteralPath $registerPy) {
  & scp @ssh $registerPy "${Remote}:/tmp/register-moyasar-webhook.py"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$remote = @'
set -euo pipefail
python3 /tmp/merge-moyasar-env.py < /tmp/usil-moyasar-payload.json
rm -f /tmp/usil-moyasar-payload.json
cd /var/www/midyaf
docker compose up -d --no-deps --force-recreate app
i=0
while [ $i -lt 40 ]; do
  i=$((i+1))
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -fsS http://127.0.0.1:3000/api/payments/moyasar
echo
if [ -f /tmp/register-moyasar-webhook.py ]; then
  USIL_ENV_PATH=/var/www/midyaf/.env.production.local python3 /tmp/register-moyasar-webhook.py || true
fi
rm -f /tmp/merge-moyasar-env.py /tmp/register-moyasar-webhook.py
'@

& ssh @ssh $Remote $remote
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
Write-Host "Done. Check https://usil.app/api/payments/moyasar for configured=true."
Write-Host "Cloudflare still needs DNS A hooks -> 8.213.85.166 DNS only (grey) for webhooks."
Write-Host $WebhookUrl
