# Completes Moyasar from .env.local: syncs secret names, creates webhook secret,
# and registers https://hooks.usil.app/api/payments/webhook.
# Never prints keys.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$EnvFile = ".env.local"
$WebhookUrl = "https://hooks.usil.app/api/payments/webhook"
$Events = @(
  "payment_paid",
  "payment_failed",
  "payment_refunded",
  "payment_voided"
)

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

function Set-DotEnvValue([string]$Path, [string]$Key, [string]$Value) {
  $lines = @()
  if (Test-Path -LiteralPath $Path) {
    $lines = Get-Content -LiteralPath $Path
  }
  $out = New-Object System.Collections.Generic.List[string]
  $found = $false
  foreach ($line in $lines) {
    if ($line -match ("^" + [regex]::Escape($Key) + "=")) {
      $out.Add("$Key=$Value") | Out-Null
      $found = $true
    } else {
      $out.Add($line) | Out-Null
    }
  }
  if (-not $found) { $out.Add("$Key=$Value") | Out-Null }
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllLines((Join-Path (Get-Location) $Path), $out.ToArray(), $utf8)
}

function Get-BasicAuth([string]$Secret) {
  $bytes = [Text.Encoding]::ASCII.GetBytes("${Secret}:")
  return [Convert]::ToBase64String($bytes)
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
  Write-Host "ما فيه .env.local في هذا المجلد. cd إلى midyaf ثم شغّل set-secret.ps1 أولاً."
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
  Write-Host "المفتاح ناقص أو فيه نجوم أو pk_. اضغط العين بجانب Secret Key وانسخ الكامل."
  Write-Host ".\scripts\set-secret.ps1 PAYMENT_PROVIDER_SECRET_KEY"
  exit 1
}

$webhookSecret = ""
if ($map.ContainsKey("MOYASAR_WEBHOOK_SECRET") -and $map["MOYASAR_WEBHOOK_SECRET"]) {
  $webhookSecret = [string]$map["MOYASAR_WEBHOOK_SECRET"]
}
if (-not $webhookSecret) {
  $webhookSecret = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
}

Set-DotEnvValue $EnvFile "MOYASAR_SECRET_KEY" $secret
Set-DotEnvValue $EnvFile "PAYMENT_PROVIDER_SECRET_KEY" $secret
Set-DotEnvValue $EnvFile "MOYASAR_WEBHOOK_SECRET" $webhookSecret
Set-DotEnvValue $EnvFile "MOYASAR_WEBHOOK_URL" $WebhookUrl

$auth = Get-BasicAuth $secret
$headers = @{
  Authorization = "Basic $auth"
  Accept        = "application/json"
}

try {
  $listed = Invoke-RestMethod -Method Get -Uri "https://api.moyasar.com/v1/webhooks" -Headers $headers
} catch {
  $code = 0
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  if ($code -eq 401) {
    Write-Host "ميسر رفض المفتاح (401). تأكد أنه sk_live_ أو sk_test_ مو pk_."
    exit 1
  }
  Write-Host "تعذر الاتصال بميسر. تحقق من النت وأعد المحاولة."
  exit 1
}

$existing = @()
if ($listed.webhooks) { $existing = @($listed.webhooks) }
elseif ($listed.data) { $existing = @($listed.data) }
elseif ($listed -is [System.Array]) { $existing = @($listed) }

$already = $false
foreach ($row in $existing) {
  $url = [string]$row.url
  if ($url.TrimEnd("/") -eq $WebhookUrl.TrimEnd("/")) { $already = $true; break }
}

if ($already) {
  Write-Host "ويبهوك ميسر مسجّل مسبقاً على hooks.usil.app"
} else {
  $body = @{
    http_method   = "post"
    url           = $WebhookUrl
    shared_secret = $webhookSecret
    events        = $Events
  } | ConvertTo-Json
  try {
    $created = Invoke-RestMethod -Method Post -Uri "https://api.moyasar.com/v1/webhooks" -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body
    $id = [string]$created.id
    Write-Host "سُجّل ويبهوك ميسر $id على hooks.usil.app"
  } catch {
    Write-Host "ميسر رفض تسجيل الويبهوك. من اللوحة: Settings → Webhooks → أضف:"
    Write-Host $WebhookUrl
    exit 1
  }
}

Write-Host "تم. باقي سجل Cloudflare: A اسم hooks على 8.213.85.166 و DNS only (رمادي)."
Write-Host "موقع usil.app الحي ما يتحدث من هذا الملف حتى يُرفع المفتاح على الخادم."
