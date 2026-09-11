# Usage (PowerShell, from the project folder):
#   .\scripts\set-secret.ps1 PAYMENT_PROVIDER_SECRET_KEY
#   .\scripts\set-secret.ps1 MOYASAR_SECRET_KEY
#   .\scripts\set-secret.ps1 MOYASAR_PUBLISHABLE_KEY
#
# Writes .env.local. Never prints the value.

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Name
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Read-Secret([string]$Prompt) {
  # AsSecureString blocks Ctrl+V in Windows PowerShell, which saved an empty key.
  try {
    Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null
    $typed = [Microsoft.VisualBasic.Interaction]::InputBox($Prompt, "Usil", "")
    if ($typed) { return [string]$typed }
  } catch {
  }
  Write-Host "Paste the value then press Enter. It is visible once."
  return [string](Read-Host "value")
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

$Name = $Name.Trim()
if (-not $Name) {
  Write-Host "اكتب اسم المتغير: PAYMENT_PROVIDER_SECRET_KEY"
  exit 1
}

$value = Read-Secret "الصق القيمة لـ $Name (ما تظهر)"
if (-not $value) {
  Write-Host "ما انحفظ شيء — القيمة فاضية."
  exit 1
}

$secretNames = @(
  "PAYMENT_PROVIDER_SECRET_KEY",
  "MOYASAR_SECRET_KEY",
  "MOYASAR_API_KEY"
)
if ($secretNames -contains $Name) {
  $value = $value.Trim().Trim('"').Trim("'")
  if ($value.Contains('*') -or $value -notmatch '^sk_(test|live)_[A-Za-z0-9]{24,}$') {
    Write-Host "غلط: هذا مو المفتاح الكامل. اضغط العين بجانب Secret Key وانسخ sk_ بدون نجوم (مو pk_)."
    exit 1
  }
}

if ($Name -eq "MOYASAR_PUBLISHABLE_KEY") {
  if ($value -notmatch '^pk_(test|live)_' -or $value.Length -lt 40) {
    Write-Host "غلط: المفتاح العام يبدأ بـ pk_test_ أو pk_live_."
    exit 1
  }
}

Set-DotEnvValue ".env.local" $Name $value
if ($Name -eq "PAYMENT_PROVIDER_SECRET_KEY") {
  Set-DotEnvValue ".env.local" "MOYASAR_SECRET_KEY" $value
}
if ($Name -eq "MOYASAR_SECRET_KEY") {
  Set-DotEnvValue ".env.local" "PAYMENT_PROVIDER_SECRET_KEY" $value
}

Write-Host "تم الحفظ في .env.local ($Name)"
if ($secretNames -contains $Name) {
  Write-Host "بعدها شغّل: .\scripts\complete-moyasar.ps1"
}
