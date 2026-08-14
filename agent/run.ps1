# dmzs-mail iCloud agent - Windows runner.
#
# Fill these in once (or set them as user environment variables and delete
# the four lines). The app password comes from account.apple.com ->
# Sign-In and Security -> App-Specific Passwords.
#
# ASCII only, deliberately. Windows PowerShell 5.1 reads a .ps1 with no BOM
# using the ANSI codepage, so a UTF-8 em dash arrives as three CP1252 chars -
# the last of which is a curly quote, which PowerShell honours as a string
# delimiter. One dash in a comment is harmless; one inside a string ends it
# early and the parser then blames a missing terminator twelve lines away.

if (-not $env:DMZS_MAIL_URL)       { $env:DMZS_MAIL_URL       = "https://mail.agentxr.app" }
if (-not $env:DMZS_MAIL_TOKEN)     { $env:DMZS_MAIL_TOKEN     = "PASTE-WORKER_TOKEN-HERE" }
if (-not $env:ICLOUD_EMAIL)        { $env:ICLOUD_EMAIL        = "you@icloud.com" }
if (-not $env:ICLOUD_APP_PASSWORD) { $env:ICLOUD_APP_PASSWORD = "xxxx-xxxx-xxxx-xxxx" }

# The agent logs a tick/cross per job. npm pipes stdout, so Python falls back
# to the locale codepage and those characters raise UnicodeEncodeError - which
# would kill the run on the first archive, not at startup where you'd see it.
$env:PYTHONUTF8 = "1"

# Refuse to start on placeholder values.
#
# The defaults above are non-empty, so the agent's own "missing environment
# variables" check passes and it cheerfully sends "PASTE-WORKER_TOKEN-HERE" as
# a bearer token. What comes back is a bare 401 traceback, restarting every 15
# seconds forever - which reads like a wrong token rather than an unset one.
$unset = @()
if (-not $env:DMZS_MAIL_TOKEN     -or $env:DMZS_MAIL_TOKEN     -like "PASTE-*") { $unset += "DMZS_MAIL_TOKEN" }
if (-not $env:ICLOUD_EMAIL        -or $env:ICLOUD_EMAIL        -eq   "you@icloud.com") { $unset += "ICLOUD_EMAIL" }
if (-not $env:ICLOUD_APP_PASSWORD -or $env:ICLOUD_APP_PASSWORD -like "xxxx-*") { $unset += "ICLOUD_APP_PASSWORD" }

if ($unset.Count -gt 0) {
    Write-Host ""
    Write-Host "Not configured yet: $($unset -join ', ')" -ForegroundColor Red
    Write-Host "Still holding the placeholder values from the top of this file."
    Write-Host ""
    Write-Host "Set them in PowerShell (not cmd), then open a NEW terminal:" -ForegroundColor Yellow
    Write-Host '  [Environment]::SetEnvironmentVariable("DMZS_MAIL_TOKEN", "<43-char agent token>", "User")'
    Write-Host '  [Environment]::SetEnvironmentVariable("ICLOUD_EMAIL", "you@icloud.com", "User")'
    Write-Host '  [Environment]::SetEnvironmentVariable("ICLOUD_APP_PASSWORD", "xxxx-xxxx-xxxx-xxxx", "User")'
    Write-Host ""
    Write-Host "Or edit the four lines at the top of this file directly."
    exit 1
}

# Lengths, never values. setx does not touch the session it runs in, so the
# usual failure is a terminal still holding the previous token while the Worker
# has moved on - identical symptoms to a wrong token, and invisible without
# this line. The agent token is 43 chars; anything else is the wrong string.
Write-Host ("config: {0} | token {1} chars{2} | password {3} chars" -f `
    $env:ICLOUD_EMAIL,
    $env:DMZS_MAIL_TOKEN.Length,
    $(if ($env:DMZS_MAIL_TOKEN.Length -ne 43) { " (expected 43)" } else { "" }),
    $env:ICLOUD_APP_PASSWORD.Length) -ForegroundColor DarkGray

# Everything also goes to a file, because the usual way to run this is hidden
# at logon with no console to read. Trimmed at 5 MB so it cannot grow forever.
$log = Join-Path $PSScriptRoot "agent.log"
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
    Move-Item $log "$log.old" -Force
}
"=== agent started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File $log -Append -Encoding utf8

# The loop survives crashes and laptop sleeps; Ctrl-C stops it for real.
while ($true) {
    python "$PSScriptRoot\icloud_agent.py" 2>&1 | Tee-Object -FilePath $log -Append
    if ($LASTEXITCODE -eq 0) { break }
    "agent exited ($LASTEXITCODE) - restarting in 15 s" | Tee-Object -FilePath $log -Append
    Start-Sleep -Seconds 15
}
