<#
install.ps1 - native Windows first-run installer (PowerShell).

One command from a fresh machine to a validated, harness-configured setup
that runs natively on PowerShell and cmd.exe - no WSL, no bash, no jq.

  # one-liner (from anywhere):
  irm https://raw.githubusercontent.com/keshm2/aplyx/main/scripts/install/install.ps1 | iex
  # or from a clone/unpacked release:
  powershell -ExecutionPolicy Bypass -File scripts\install\install.ps1

Steps mirror scripts/install/install.sh:
  0. Bootstrap when piped/outside the repo: download+unpack the source, re-run.
  1. Prereqs: python (py/python); node+npm optional for the TUI.
  2. Copy config/*.example.json to live configs where missing.
  2b. Optional Discord status updates (opt-in).
  3. Detect installed coding agents; write config/harness.json.
  4. Ask for the profile (safe_fields, kept LOCAL ONLY).
  5. Offer .claude/settings.json (headless permissions) when Claude Code present.
  6. Regenerate per-harness agent definitions.
  7. Run the config validator.
  8. Build the TUI (app/) when node is available.
  9. Put the `aplyx` command on PATH (aplyx.cmd + aplyx.ps1 shims).
#>

$ErrorActionPreference = "Stop"

function Say  { param($m) Write-Host "install: $m" }
function Warn { param($m) Write-Host "install: WARNING: $m" -ForegroundColor Yellow }
function Fail { param($m) Write-Host "install: ERROR: $m" -ForegroundColor Red; exit 1 }

# Builds a $Width-column bar with a $Block-wide highlighted segment that
# slides back and forth (ping-pong) as $I increases — the indeterminate-
# progress analog of Format-DownloadBar below, for steps with no byte
# total to measure against (npm install). Not a percentage — there's
# nothing to measure it against — but visually one system with the
# byte-tracked download bar instead of a bare spinner character.
function Format-IndeterminateBar {
  param([int]$I, [int]$Width, [int]$Block)
  $range = $Width - $Block
  $period = $range * 2
  $pos = $I % $period
  if ($pos -gt $range) { $pos = $period - $pos }
  return ("." * $pos) + ("=" * $Block) + ("." * ($Width - $pos - $Block))
}

# Runs $Block with an indeterminate sliding bar next to $Message while
# it's in a background job — for steps with no byte total to show (npm
# install), the PowerShell counterpart to install.sh's spin(). Falls back
# to a plain "$Message..." line with no live redraw when output isn't a
# real console (piped install, CI) since \r redraws would just spam a log
# with junk.
function Spin {
  param([string]$Message, [scriptblock]$Block)
  if ([Console]::IsOutputRedirected) {
    Write-Host "$Message..."
    & $Block
    return
  }
  $job = Start-Job -ScriptBlock $Block
  $width = 20; $block = 6
  $i = 0
  while ($job.State -eq "Running") {
    Write-Host -NoNewline ("`r{0} [{1}]" -f $Message, (Format-IndeterminateBar -I $i -Width $width -Block $block))
    $i++
    Start-Sleep -Milliseconds 100
  }
  Receive-Job -Job $job -Wait -AutoRemoveJob | Out-Null
  $ok = $job.State -eq "Completed"
  Write-Host -NoNewline ("`r{0}`r" -f (" " * ($Message.Length + $width + 4)))
  if (-not $ok) { throw "$Message failed" }
}

function Get-ContentLength {
  param([string]$Url)
  try {
    $resp = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -ErrorAction Stop
    $len = $resp.Headers['Content-Length']
    if ($len) { return [int64]$len }
  } catch {}
  return 0
}

# Renders a fixed-width [====>.....] bar plus "current/total" in MB
# (decimal) for $Current/$Total bytes into $Width columns. $Total <= 0
# (Content-Length wasn't available) degrades to a bytes-downloaded
# counter with no bar/percentage.
function Format-DownloadBar {
  param([int64]$Current, [int64]$Total, [int]$Width)
  $filled = 0
  if ($Total -gt 0) {
    $filled = [Math]::Min($Width, [Math]::Floor($Current * $Width / $Total))
  }
  $bar = ""
  if ($filled -gt 0) { $bar = ("=" * ($filled - 1)) + ">" }
  $bar += "." * ($Width - $filled)
  $curMb = [Math]::Floor($Current / 1000000)
  if ($Total -gt 0) {
    $totMb = [Math]::Floor($Total / 1000000)
    return "[$bar] ${curMb}MB/${totMb}MB "
  }
  return "[$bar] ${curMb}MB downloaded "
}

# Downloads $Url to $OutFile with a live byte-tracked bar — a HEAD request
# gets the total size, a background job does the real download, and this
# polls the growing file's size to redraw the bar. Falls back to a single
# "downloading..." line with no live redraw when output isn't a real
# console, same reasoning as Spin.
function Get-FileWithProgress {
  param([string]$Url, [string]$OutFile)
  $total = Get-ContentLength -Url $Url
  if ([Console]::IsOutputRedirected) {
    Write-Host "downloading $(Split-Path -Leaf $OutFile)..."
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    return
  }
  $job = Start-Job -ScriptBlock {
    param($u, $o)
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri $u -OutFile $o -UseBasicParsing
  } -ArgumentList $Url, $OutFile
  $width = 30
  while ($job.State -eq "Running") {
    $current = 0
    if (Test-Path $OutFile) { $current = (Get-Item $OutFile).Length }
    Write-Host -NoNewline ("`r" + (Format-DownloadBar -Current $current -Total $total -Width $width))
    Start-Sleep -Milliseconds 200
  }
  Receive-Job -Job $job -Wait -AutoRemoveJob | Out-Null
  $ok = $job.State -eq "Completed"
  $current = 0
  if (Test-Path $OutFile) { $current = (Get-Item $OutFile).Length }
  Write-Host ("`r" + (Format-DownloadBar -Current $current -Total $total -Width $width))
  if (-not $ok) { throw "download failed: $Url" }
}

function Find-Python {
  foreach ($c in @(@("py","-3"), @("python"), @("python3"))) {
    $exe = $c[0]
    if (Get-Command $exe -ErrorAction SilentlyContinue) {
      try { & $exe @($c[1..($c.Length-1)] + "--version") *> $null; if ($LASTEXITCODE -eq 0) { return ,$c } } catch {}
    }
  }
  return $null
}

# --- 0. Bootstrap ------------------------------------------------------------
# (The npm-installed `aplyx` command mirrors this bootstrap; its own
# --no-core flag / APLYX_SKIP_CORE=1 opt-out has no equivalent here since
# this script IS the install.)
$scriptPath = $PSCommandPath
$projectRoot = $null
if ($scriptPath) {
  $maybeRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $scriptPath))
  if (Test-Path (Join-Path $maybeRoot "AGENTS.md")) { $projectRoot = $maybeRoot }
}
if (-not $projectRoot) {
  $target = if ($env:APLYX_HOME) { $env:APLYX_HOME } elseif ($env:FLUX_HOME) { $env:FLUX_HOME } else { Join-Path $HOME "aplyx" }
  if (Test-Path (Join-Path $target "AGENTS.md")) {
    Say "existing install found at $target - refreshing it from GitHub before re-running."
  } else {
    Say "downloading aplyx into $target ..."
  }
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  # Always re-fetch and overwrite tracked files, even for an existing install:
  # heals a stale or corrupted local copy (e.g. an old script version with a
  # bug) instead of re-running whatever happens to already be on disk.
  # Gitignored local state (config\*.json, data\, logs\, docs\PLAN.md)
  # isn't in the tarball, so it's left untouched.
  $tgz = Join-Path $env:TEMP ("aplyx-" + [System.Guid]::NewGuid().ToString() + ".tar.gz")
  Get-FileWithProgress -Url "https://codeload.github.com/keshm2/aplyx/tar.gz/refs/heads/main" -OutFile $tgz
  # tar.exe ships with Windows 10+; --strip-components drops the top dir.
  & tar.exe -xzf $tgz --strip-components=1 -C $target
  if ($LASTEXITCODE -ne 0) { Fail "failed to unpack the source tarball (needs Windows 10+ tar.exe)" }
  Remove-Item $tgz -ErrorAction SilentlyContinue
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $target "scripts\install\install.ps1")
  exit $LASTEXITCODE
}
Set-Location $projectRoot

# Pin this checkout's location to ~/.aplyx/root, read by
# packages/core/src/project.ts's findProjectRoot() as its primary
# resolution signal. Written unconditionally, first, regardless of what
# happens in the rest of this script: a Finder/Dock-launched (or
# Start-Menu-launched) desktop app has no shell env vars and no
# meaningful working directory to fall back on, so without this pin a
# brand-new install would land straight on the app's "browse for my aplyx
# folder" manual recovery screen every time.
$pinDir = Join-Path $HOME ".aplyx"
New-Item -ItemType Directory -Force -Path $pinDir | Out-Null
Set-Content -Path (Join-Path $pinDir "root") -Value $projectRoot -NoNewline

# --- 1. Prerequisites --------------------------------------------------------
# Detect everything missing FIRST (Python + the one required Python
# package, pypdf - resume PDF conversion silently can't work without it)
# and ask once, rather than hard-failing on the first missing thing: most
# users running the one-liner have no idea what pypdf even is, and would
# rather aplyx just installed it. No jq here - this path is pure
# PowerShell/Python by design (see the file header).
$py = Find-Python
$missingPython = -not $py
$missingPypdf = $false
if ($py) {
  # try/catch, not just a $LASTEXITCODE check: on PowerShell 7.3+ with
  # $PSNativeCommandUseErrorActionPreference on (increasingly the
  # default), a non-zero exit from a native command under
  # $ErrorActionPreference = "Stop" (set at the top of this script)
  # throws instead of just setting $LASTEXITCODE — exactly what
  # happens here when pypdf is genuinely missing (the expected,
  # common case this check exists to catch), which crashed the whole
  # installer with a raw exception instead of reaching the code below
  # that's supposed to offer to install it.
  try {
    & $py[0] @($py[1..($py.Length-1)] + @("-c", "import pypdf")) *> $null
    if ($LASTEXITCODE -ne 0) { $missingPypdf = $true }
  } catch {
    $missingPypdf = $true
  }
}

if ($missingPython -or $missingPypdf) {
  Write-Host ""
  if ($missingPython) { Warn "not detected: Python 3" }
  if ($missingPypdf)  { Warn "not detected (Python package): pypdf - needed for resume PDF conversion" }
  Warn "these are needed to continue installing aplyx."
  $installDeps = Read-Host "Install them now? [Y/n]"
  if (-not $installDeps) { $installDeps = "y" }
  if ($installDeps -notmatch '^[Yy]') {
    $missing = @()
    if ($missingPython) { $missing += "Python 3" }
    if ($missingPypdf)  { $missing += "pypdf" }
    Fail "cannot continue without: $($missing -join ', '). Install them yourself and re-run."
  }

  if ($missingPython) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Say "installing Python 3 via winget ..."
      $wingetFailed = $false
      try {
        winget install --id Python.Python.3 -e --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { $wingetFailed = $true }
      } catch {
        $wingetFailed = $true
      }
      if ($wingetFailed) {
        Fail "failed to install Python via winget - install from https://www.python.org/ (check 'Add to PATH') and re-run."
      }
      # winget just installed it into a PATH entry this process started without.
      $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
      $py = Find-Python
      if (-not $py) { Fail "Python 3 installed but not found on PATH yet - open a new terminal and re-run." }
      Say "installed Python 3."
    } else {
      Fail "Python 3 is required and winget isn't available to install it automatically. Install from https://www.python.org/ (check 'Add to PATH') and re-run."
    }
  }

  if ($missingPypdf) {
    $pipFailed = $false
    try {
      & $py[0] @($py[1..($py.Length-1)] + @("-m", "pip", "install", "--user", "pypdf"))
      if ($LASTEXITCODE -ne 0) { $pipFailed = $true }
    } catch {
      $pipFailed = $true
    }
    if ($pipFailed) { Fail "failed to install pypdf - run 'py -3 -m pip install --user pypdf' manually and re-run." }
    Say "installed: pypdf"
  }
}

if (-not $py) { Fail "Python 3 is required. Install from https://www.python.org/ (check 'Add to PATH')." }
# Named Invoke-Python, not the shorter "Py" the call sites below originally
# used: PowerShell command-name resolution is case-insensitive and prefers
# functions over external executables, so a function literally named `Py`
# self-invoked instead of the real py.exe launcher whenever Find-Python
# picked the `py` launcher (`$py[0]` -eq "py", "-3") — the standard outcome
# for anyone who installed Python from python.org or via winget, i.e. most
# Windows users. `& $py[0] ...` resolved to this very function instead of
# the launcher, recursing until PowerShell's call-depth limit tripped
# ("CallDepthOverflow"), hanging every fresh Windows install right at the
# first call site (agent-definition generation, step 6). A verb-noun name
# can never collide with a real Windows command.
function Invoke-Python { param([string[]]$a) & $py[0] @($py[1..($py.Length-1)] + $a) }

# --- 2. Live configs from examples -------------------------------------------
if (Test-Path "config\targets.json") {
  Say "config/targets.json exists - keeping it."
} else {
  Copy-Item "config\targets.example.json" "config\targets.json"
  Say "created config/targets.json from the example - fill placeholders (or run 'aplyx setup')."
}

# --- 2b. Discord (optional, opt-in) ------------------------------------------
$discordLive = "config\discord_config.json"
function Write-DisabledDiscord {
  '{
  "enabled": false,
  "webhooks": {}
}' | Set-Content -Encoding UTF8 $discordLive
}
if (Test-Path $discordLive) {
  Say "$discordLive exists - keeping it."
} else {
  $optIn = Read-Host "Use Discord for status updates (applied / needs-review / failed / summary)? [y/N]"
  if ($optIn -eq "y" -or $optIn -eq "Y") {
    Write-Host ""
    Write-Host "How should the updates be routed?"
    Write-Host "  1) One channel for ALL status updates (one webhook link)"
    Write-Host "  2) Separate channels per status (success / needs-review / failed / summary)"
    Write-Host "!  Separate channels: Discord binds each webhook to ONE channel, so" -ForegroundColor Yellow
    Write-Host "   EACH channel needs its own webhook link (4 links for option 2)." -ForegroundColor Yellow
    $mode = Read-Host "Choose [1/2, default 1]"
    if ($mode -eq "2") {
      $s = Read-Host "  success webhook URL"
      $r = Read-Host "  needs-review webhook URL"
      $f = Read-Host "  failed webhook URL"
      $m = Read-Host "  summary webhook URL (optional, enter to fall back to success)"
    } else {
      $all = Read-Host "  the one shared webhook URL"
      $s = $all; $r = $all; $f = $all; $m = $all
    }
    if ([string]::IsNullOrWhiteSpace($s)) {
      Warn "no webhook URL entered - writing Discord as disabled; enable later with 'aplyx setup'."
      Write-DisabledDiscord
    } else {
      $webhooks = [ordered]@{ success = $s; needs_review = $r; failed = $f }
      if (-not [string]::IsNullOrWhiteSpace($m)) { $webhooks["summary"] = $m }
      [ordered]@{ enabled = $true; webhooks = $webhooks } | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $discordLive
      Say "wrote $discordLive (Discord enabled)."
    }
  } else {
    Write-DisabledDiscord
    Say "Discord skipped - outcomes stay local (state files + TUI). Enable any time with 'aplyx setup'."
  }
}

# --- 3. Harness detection ----------------------------------------------------
$labels = @{
  opencode = "opencode"
  claude   = "Claude Code"
  codex    = "Codex CLI          (API boards only unless browser tooling is configured)"
  copilot  = "GitHub Copilot CLI (API boards only unless browser tooling is configured)"
}
$detected = @()
foreach ($a in @("opencode","claude","codex","copilot")) {
  if (Get-Command $a -ErrorAction SilentlyContinue) { $detected += $a }
}
if ($detected.Count -eq 0) {
  Warn "no supported coding agent found (opencode, claude, codex, or copilot)."
  Warn "install one, then re-run: https://opencode.ai / https://claude.com/claude-code /"
  Warn "  https://developers.openai.com/codex/cli / https://docs.github.com/copilot"
}
if (Test-Path "config\harness.json") {
  Say "config/harness.json exists - keeping it."
} else {
  $harness = ""
  if ($detected.Count -gt 1) {
    Write-Host ""
    Write-Host "Which coding agent should aplyx use for runs?"
    for ($i = 0; $i -lt $detected.Count; $i++) { Write-Host ("  {0}) {1}" -f ($i+1), $labels[$detected[$i]]) }
    $choice = Read-Host ("Choose [1-{0}, default 1]" -f $detected.Count)
    $n = 0
    if (-not [int]::TryParse($choice, [ref]$n) -or $n -lt 1 -or $n -gt $detected.Count) { $n = 1 }
    $harness = $detected[$n-1]
  } elseif ($detected.Count -eq 1) {
    $harness = $detected[0]
  }
  if ($harness) {
    [ordered]@{ harness = $harness } | ConvertTo-Json | Set-Content -Encoding UTF8 "config\harness.json"
    Say "wrote config/harness.json (harness: $harness)."
  } else {
    Say "skipped config/harness.json - no supported coding agent detected yet."
  }
}

# --- 4. Profile (safe_fields, LOCAL ONLY) -------------------------------
Say "profile: run 'aplyx' (or 'aplyx setup') to fill in your name, contact info, and job targets through the guided wizard - or edit config/targets.json by hand (see the _help notes in config/targets.example.json)."
New-Item -ItemType Directory -Force -Path "data\resumes" | Out-Null
Write-Host ""
Write-Host "[docs] Resumes: add your base resumes (markdown + matching PDF) to" -ForegroundColor Cyan
Write-Host ("       " + (Join-Path $projectRoot "data\resumes")) -ForegroundColor Cyan
Write-Host "       See docs/SETUP.md for the expected filenames - aplyx picks one" -ForegroundColor Cyan
Write-Host "       per job by category and tailors it. This folder is gitignored - local only." -ForegroundColor Cyan
Write-Host ""

# --- 5. Claude Code headless permissions (opt-in) ----------------------------
if ((Get-Command claude -ErrorAction SilentlyContinue) -and -not (Test-Path ".claude\settings.json")) {
  Write-Host ""
  Write-Host "Claude Code headless runs need pre-approved permissions in .claude/settings.json:"
  Write-Host '  Bash(*), Edit(*), Write(*), Read(*), mcp__playwright__* (repo-local)'
  $mk = Read-Host "Create it now? [y/N]"
  if ($mk -eq "y" -or $mk -eq "Y") {
    New-Item -ItemType Directory -Force -Path ".claude" | Out-Null
    @'
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Edit(*)",
      "Write(*)",
      "Read(*)",
      "mcp__playwright__*"
    ]
  },
  "enableAllProjectMcpServers": true
}
'@ | Set-Content -Encoding UTF8 ".claude\settings.json"
    Say "wrote .claude/settings.json."
  } else {
    Say "skipped .claude/settings.json - headless Claude runs will prompt for permissions."
  }
}

# --- 6. Agent definitions ----------------------------------------------------
Invoke-Python @("scripts\validate\generate_agent_definitions.py")

# --- 7. Validate -------------------------------------------------------------
Invoke-Python @("scripts\validate\validate_local_config.py")
if ($LASTEXITCODE -eq 0) {
  Say "config valid."
} else {
  Warn "config not valid yet - edit the files named above (or run 'aplyx setup'), then re-run the validator."
}

# --- 8. TUI / extension (optional) -------------------------------------------
function Build-NodeSurface {
  param([string]$Dir, [string]$Label)
  if (-not (Test-Path (Join-Path $Dir "package.json"))) { return }
  if ((Test-Path (Join-Path $Dir "node_modules")) -and (Test-Path (Join-Path $Dir "dist"))) {
    Say "$Label already installed."
    return
  }
  try {
    Spin -Message "building $Label ($Dir/)" -Block {
      Push-Location $using:Dir
      & npm install --silent
      if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
      & npm run build --silent
      if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    }
    Say "$Label ready."
  } catch {
    Warn "$Label build failed - see docs/SETUP.md."
  }
}

if (Get-Command npm -ErrorAction SilentlyContinue) {
  # packages/core has no install/prepare hook that builds it automatically -
  # app/'s and desktop/'s own `tsc` builds both need its dist/ already
  # present to resolve `@aplyx/core/*` imports, which is never true on a
  # fresh clone. Build it first so both surfaces build clean below.
  # try/catch, not just a $LASTEXITCODE check - same native-command-under-
  # Stop gotcha noted by the Python check above; this step must only warn,
  # never abort the rest of the installer.
  try {
    Spin -Message "building the shared core" -Block {
      npm run build:core --silent
      if ($LASTEXITCODE -ne 0) { throw "core build failed" }
    }
  } catch {
    Warn "core build failed - the TUI build below will likely fail too. See docs/SETUP.md."
  }
  Build-NodeSurface "app" "the TUI"
  Build-NodeSurface "extension" "the browser extension"
} else {
  Say "node/npm not found - skipping the optional TUI and browser extension (docs/SETUP.md)."
}

# --- 8b. Desktop app (optional, early preview) --------------------------------
# Ships ALONGSIDE the TUI at this stage, not in place of it (that flips
# later). Building it needs Rust + Visual C++ Build Tools on top of Node -
# real prerequisites the TUI doesn't have - so this is opt-in and its own
# script (install_desktop.ps1), and a failure here never fails this
# installer: the TUI install above already succeeded and stays fully
# usable either way.
if ((Test-Path "desktop\package.json") -and (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "aplyx also has an early-preview desktop app (Tauri), alongside the TUI."
  Write-Host "Building it needs a Rust toolchain and Visual C++ Build Tools - this script"
  Write-Host "offers to install anything missing, and first-time compiling can take"
  Write-Host "several minutes."
  $installApp = Read-Host "Install the desktop app too? [y/N]"
  if ($installApp -eq "y" -or $installApp -eq "Y") {
    # try/catch, not just a $LASTEXITCODE check: on PowerShell 7.3+ with
    # $PSNativeCommandUseErrorActionPreference on (increasingly the
    # default), a non-zero exit from a native command under
    # $ErrorActionPreference = "Stop" throws instead of just setting
    # $LASTEXITCODE — same gotcha as the Python check above. This step is
    # opt-in and must never abort the rest of this installer.
    $desktopFailed = $false
    try {
      & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot "scripts\install\install_desktop.ps1")
      if ($LASTEXITCODE -ne 0) { $desktopFailed = $true }
    } catch {
      $desktopFailed = $true
    }
    if ($desktopFailed) {
      Warn "desktop app install failed (see above) - the TUI is unaffected. Fix the issue and retry any time with:"
      Warn "  powershell -ExecutionPolicy Bypass -File scripts\install\install_desktop.ps1"
    }
  }
}

# --- 9. `aplyx` command on PATH ---------------------------------------------
$cliJs = Join-Path $projectRoot "app\dist\cli.js"
if ((Test-Path $cliJs) -and (Get-Command node -ErrorAction SilentlyContinue)) {
  $binDir = if ($env:APLYX_BIN) { $env:APLYX_BIN } elseif ($env:FLUX_BIN) { $env:FLUX_BIN } else { Join-Path $env:LOCALAPPDATA "aplyx\bin" }
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $cmdShim = Join-Path $binDir "aplyx.cmd"
  $ps1Shim = Join-Path $binDir "aplyx.ps1"

  # Clean up an older-name shim from a previous rebrand so a re-run doesn't
  # leave both `flux` and `aplyx` on PATH pointing at this checkout.
  foreach ($oldName in @("flux")) {
    $oldShim = Join-Path $binDir "$oldName.cmd"
    if ((Test-Path $oldShim) -and ((Get-Content $oldShim -Raw -ErrorAction SilentlyContinue) -match "$oldName wrapper") -and ((Get-Content $oldShim -Raw -ErrorAction SilentlyContinue) -match [regex]::Escape($projectRoot))) {
      Remove-Item $oldShim, (Join-Path $binDir "$oldName.ps1") -ErrorAction SilentlyContinue
      Say "removed the older ``$oldName`` command ($oldShim)."
    }
  }

  $foreign = (Test-Path $cmdShim) -and -not ((Get-Content $cmdShim -Raw -ErrorAction SilentlyContinue) -match "aplyx wrapper")
  if ($foreign) {
    Warn "$cmdShim exists and is not aplyx's wrapper - leaving it alone."
  } else {
    @"
@echo off
REM aplyx wrapper - generated by scripts/install/install.ps1; safe to delete.
REM Falls back to common install locations if this was moved or renamed
REM after install, before giving up with an actionable error.
set "PIN=$projectRoot"
set "ROOT="
if defined APLYX_ROOT if exist "%APLYX_ROOT%\app\dist\cli.js" set "ROOT=%APLYX_ROOT%"
if not defined ROOT if exist "%PIN%\app\dist\cli.js" set "ROOT=%PIN%"
if not defined ROOT if defined APLYX_HOME if exist "%APLYX_HOME%\app\dist\cli.js" set "ROOT=%APLYX_HOME%"
if not defined ROOT if defined FLUX_ROOT if exist "%FLUX_ROOT%\app\dist\cli.js" set "ROOT=%FLUX_ROOT%"
if not defined ROOT if defined FLUX_HOME if exist "%FLUX_HOME%\app\dist\cli.js" set "ROOT=%FLUX_HOME%"
if not defined ROOT if exist "%USERPROFILE%\aplyx\app\dist\cli.js" set "ROOT=%USERPROFILE%\aplyx"
if not defined ROOT if exist "%USERPROFILE%\flux\app\dist\cli.js" set "ROOT=%USERPROFILE%\flux"
if not defined ROOT if exist "%USERPROFILE%\ares\app\dist\cli.js" set "ROOT=%USERPROFILE%\ares"
if not defined ROOT goto :notfound
if not defined APLYX_ROOT set "APLYX_ROOT=%ROOT%"
node "%ROOT%\app\dist\cli.js" %*
goto :eof
:notfound
echo aplyx: install directory not found - last known %PIN% 1>&2
echo aplyx: if you moved it, set APLYX_ROOT to the new location or re-run its installer. 1>&2
exit /b 1
"@ | Set-Content -Encoding ASCII $cmdShim
    @"
# aplyx wrapper - generated by scripts/install/install.ps1; safe to delete.
# Falls back to common install locations if this was moved or renamed
# after install, before giving up with an actionable error.
`$pin = "$projectRoot"
`$root = `$null
foreach (`$c in @(`$env:APLYX_ROOT, `$pin, `$env:APLYX_HOME, `$env:FLUX_ROOT, `$env:FLUX_HOME, (Join-Path `$env:USERPROFILE "aplyx"), (Join-Path `$env:USERPROFILE "flux"), (Join-Path `$env:USERPROFILE "ares"))) {
  if (`$c -and (Test-Path (Join-Path `$c "app\dist\cli.js"))) { `$root = `$c; break }
}
if (-not `$root) {
  Write-Host "aplyx: install directory not found (last known: $projectRoot)." -ForegroundColor Red
  Write-Host "aplyx: if you moved it, set APLYX_ROOT to the new location or re-run its installer." -ForegroundColor Red
  exit 1
}
if (-not `$env:APLYX_ROOT) { `$env:APLYX_ROOT = `$root }
node "`$root\app\dist\cli.js" @args
"@ | Set-Content -Encoding UTF8 $ps1Shim
    Say "installed the aplyx command: $cmdShim"

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (($userPath -split ";") -notcontains $binDir) {
      [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $binDir), "User")
      Warn "added $binDir to your user PATH - open a NEW terminal for `aplyx` to resolve."
    }
  }
}

Say "done. Open a new terminal and try: aplyx   (updates auto-install; APLYX_AUTO_UPDATE=0 disables)."
