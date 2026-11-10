# Run once per NEW project. Output is saved locally, never printed.
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9]{20}$')][string]$ProjectRef)
$secretFile = Join-Path $PSScriptRoot ("nova-poshta-" + $ProjectRef + ".secrets.env")
if (Test-Path -LiteralPath $secretFile) { throw "Key file already exists. Preserve the existing encryption key." }
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$key = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
$stream = [System.IO.File]::Open($secretFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
try {
  $content = [System.Text.Encoding]::ASCII.GetBytes("NP_ENCRYPTION_KEY=" + $key + [Environment]::NewLine)
  $stream.Write($content, 0, $content.Length)
} finally { $stream.Dispose(); [Array]::Clear($bytes, 0, $bytes.Length); $key = $null }
Write-Host "Key saved locally. Add NP_ENCRYPTION_KEY to Supabase Edge Functions Secrets. Do not share this file."
