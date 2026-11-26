# Run from the PROJECT ROOT:  .\scripts\set-api-url.ps1 -ProjectRef abcdefghijklmnopqrst
# Writes your Supabase project ref into public/index.html (the only frontend change). Contains no secrets.
param([Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]{15,25}$')][string]$ProjectRef)
$file = Join-Path $PSScriptRoot '..\public\index.html'
$text = [System.IO.File]::ReadAllText($file)
$pattern = "const API_BASE = 'https://[^']*/functions/v1';"
if ($text -notmatch $pattern) { throw 'API_BASE line not found in public/index.html' }
$new = "const API_BASE = 'https://$ProjectRef.supabase.co/functions/v1';"
[System.IO.File]::WriteAllText($file, [regex]::Replace($text, $pattern, $new), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "API_BASE set to: https://$ProjectRef.supabase.co/functions/v1"
