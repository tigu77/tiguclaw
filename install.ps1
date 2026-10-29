# tiguclaw 한 줄 설치 (Windows / PowerShell)
#
#   irm https://raw.githubusercontent.com/tigu77/tiguclaw/main/install.ps1 | iex
#
# 하는 일: 전제 확인 → clone → npm ci → onboard 로 넘김.
# 하지 않는 일: 설정을 대신 정하지 않는다(대화형 onboard 가 그 자리다).
#
# ★`irm | iex` 는 현재 콘솔에서 실행되므로 stdin 은 살아 있다(sh 판과 다른 점).
#  대신 여기선 **관리자 권한을 요구하지 않는다** — 데몬 등록이 *사용자 수준* 예약작업
#  (`Register-ScheduledTask … -RunLevel Limited`)이라서다. 2026-08-22 이전엔 HKCU Run
#  키였는데, 그건 로그온 1회라 supervisor 가 없었다(죽으면 그대로 멈춤).

$ErrorActionPreference = 'Stop'

$RepoUrl  = 'https://github.com/tigu77/tiguclaw.git'
$Dir      = if ($env:TIGUCLAW_DIR) { $env:TIGUCLAW_DIR } else { Join-Path $env:USERPROFILE 'tiguclaw' }
$MinNode  = 20
# 자동 설치할 때 고를 LTS 계열 — 네이티브 미리빌드가 LTS 를 따라간다(sh 판과 같은 값).
$LtsMajor = if ($env:TIGUCLAW_NODE_MAJOR) { $env:TIGUCLAW_NODE_MAJOR } else { '22' }

# ★`exit` 를 쓰지 않는다 (2026-10-18, 깨끗한 윈도우 실기). `irm | iex` 는 사용자 창 안에서 돌아서, `exit 1` 이
#  **사용자의 PowerShell 창 자체를 닫았다** — 빨간 안내를 읽기도 전에 창이 사라졌다. 던져서 맨 아래 catch 가 받는다.
function Die($msg) { Write-Host "`n[X] $msg" -ForegroundColor Red; throw 'TIGUCLAW_DIE' }

try {

Write-Host ""
Write-Host "=== Installing tiguclaw ===" -ForegroundColor Cyan
Write-Host "Install location: $Dir   (to change it: `$env:TIGUCLAW_DIR='D:\tiguclaw')"
Write-Host ""

# Existing directory != finished installation. Do not overwrite a partial/unrelated checkout.
$ExistingInstall = Test-Path -LiteralPath $Dir
if ($ExistingInstall) {
  $packageFile = Join-Path $Dir 'package.json'
  if (!(Test-Path -LiteralPath $packageFile) -or !(Test-Path -LiteralPath (Join-Path $Dir '.git'))) {
    Die "Existing folder is not a complete tiguclaw checkout: $Dir. Keep it for recovery; inspect/rename it yourself or choose another TIGUCLAW_DIR, then rerun. Nothing was overwritten."
  }
  $existingPackage = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
  if ($existingPackage.name -ne 'tiguclaw' -or !(Test-Path -LiteralPath (Join-Path $Dir 'bin\tiguclaw.mjs'))) {
    Die 'This is not a tiguclaw install. Choose another TIGUCLAW_DIR; the folder was not changed.'
  }
  # npm ci/build must not replace files held by a running daemon. Unknown is not stopped.
  try {
    $nodes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
    $needle = [IO.Path]::GetFullPath($Dir).Replace('/', '\').ToLowerInvariant()
    foreach ($proc in $nodes) {
      # WMI does not expose cwd. A relative tiguclaw daemon entry cannot be proved unrelated.
      $unscopedDaemon = $proc.CommandLine -match '(?i)(?:^|[\s"])(?:[^\\/\s":]+[\\/])*(?:(?:dist[\\/])?src[\\/]index\.(?:js|ts)|bin[\\/]daemon\.mjs)(?:\s|$|")'
      if (!$proc.CommandLine -or $unscopedDaemon -or $proc.CommandLine.Replace('/', '\').ToLowerInvariant().Contains($needle) -or
          ($proc.ExecutablePath -and $proc.ExecutablePath.Replace('/', '\').ToLowerInvariant().StartsWith($needle + '\'))) {
        throw 'Running or uninspectable Node process'
      }
    }
  } catch {
    Die "Cannot establish that this install is stopped. No dependencies were changed. Use node.exe `"$Dir\bin\tiguclaw.mjs`" status / stop, then rerun. For a normal update use node.exe `"$Dir\bin\tiguclaw.mjs`" update. ($($_.Exception.Message))"
  }
}

# System Git first; opt-in app-private PortableGit includes Bash (MinGit does not).
$GitRoot = Join-Path $env:LOCALAPPDATA 'tiguclaw\tools\git'
$PrivateGit = Join-Path $GitRoot 'cmd\git.exe'
$PrivateBash = Join-Path $GitRoot 'bin\bash.exe'
function Enable-PrivateGit {
  $env:Path = (Join-Path $GitRoot 'cmd') + ";" + $env:Path
  # Bash is discovered by the CLI after the home .env has had its say.
}
$GitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
if (!$GitCmd) {
  if ((Test-Path -LiteralPath $PrivateGit) -and (Test-Path -LiteralPath $PrivateBash) -and
      (Test-Path -LiteralPath (Join-Path $GitRoot 'tiguclaw-portable-git.json'))) {
    & $PrivateGit --version | Out-Null
    if ($LASTEXITCODE -ne 0) { Die 'App-private Git is damaged. Inspect/rename it or install Git for Windows yourself, then rerun.' }
    & $PrivateBash --version | Out-Null
    if ($LASTEXITCODE -ne 0) { Die 'App-private Bash is damaged. Inspect/rename it or install Git for Windows yourself, then rerun.' }
    Enable-PrivateGit
  } else {
    if (Test-Path -LiteralPath $GitRoot) { Die "Incomplete private Git at $GitRoot. It was not overwritten. Inspect/rename it or install Git for Windows yourself, then rerun." }
    Write-Host "Git is missing. Prepare official PortableGit (Git + Bash) in $GitRoot?"
    Write-Host 'Only this app/process uses it; machine/user PATH and execution policy are not changed.'
    $consent = Read-Host 'Download, verify SHA256 and run the official PortableGit extractor? [y/N]'
    if ($consent -notmatch '^(?i:y|yes)$') {
      Die 'Git preparation declined. Install Git for Windows from https://git-scm.com/download/win and rerun. Settings are kept.'
    }
    $gitArch = $(if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }).ToLowerInvariant()
    $assetArch = switch ($gitArch) { 'arm64' { 'arm64' } 'amd64' { '64-bit' } default { Die "Unsupported PortableGit architecture: $gitArch" } }
    $release = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'tiguclaw-installer' }
    $assets = @($release.assets | Where-Object { $_.name -match "^PortableGit-[0-9.]+-$assetArch\.7z\.exe$" })
    if ($assets.Count -ne 1) { Die 'Official PortableGit asset is missing/ambiguous. Retry later or install Git for Windows manually.' }
    $asset = $assets[0]
    if ($asset.digest -notmatch '^sha256:[a-fA-F0-9]{64}$' -or
        $asset.browser_download_url -notmatch '^https://github\.com/git-for-windows/git/releases/download/[a-zA-Z0-9._-]+/PortableGit-[0-9.]+-(64-bit|arm64)\.7z\.exe$') {
      Die 'Official PortableGit URL/SHA256 metadata is unavailable. Nothing will be executed; retry later.'
    }
    $download = Join-Path ([IO.Path]::GetTempPath()) ('tiguclaw-portable-git-' + [guid]::NewGuid().ToString('N') + '.exe')
    $stage = Join-Path (Split-Path $GitRoot -Parent) ('git-partial-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $download -UseBasicParsing
    $actual = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash
    if ($actual -ine $asset.digest.Substring(7)) { Die 'PortableGit SHA256 mismatch. Extractor was NOT run. Rerun to download a fresh copy.' }
    $extract = Start-Process -FilePath $download -ArgumentList @('-y', ('-o"' + $stage + '"')) -Wait -PassThru
    if ($extract.ExitCode -ne 0) { Die "PortableGit extraction failed ($($extract.ExitCode)); rerun. Incomplete staging was not reused." }
    $stageGit = Join-Path $stage 'cmd\git.exe'
    $stageBash = Join-Path $stage 'bin\bash.exe'
    if (!(Test-Path -LiteralPath $stageGit) -or !(Test-Path -LiteralPath $stageBash)) { Die 'PortableGit extraction is incomplete; no tool path was enabled.' }
    & $stageGit --version | Out-Null
    if ($LASTEXITCODE -ne 0) { Die 'Extracted Git failed its version check.' }
    & $stageBash --version | Out-Null
    if ($LASTEXITCODE -ne 0) { Die 'Extracted Bash failed its version check.' }
    @{ asset = $asset.name; sha256 = $actual; source = $asset.browser_download_url } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'tiguclaw-portable-git.json') -Encoding UTF8
    [IO.Directory]::Move($stage, $GitRoot)
    Enable-PrivateGit
    Write-Host '  SHA256 verified; app-private Git + Bash ready.'
  }
  $GitCmd = Get-Command git.exe -ErrorAction Stop
}
$GitExe = $GitCmd.Source
if ($ExistingInstall) {
  $origin = & $GitExe -C $Dir remote get-url origin
  if ($LASTEXITCODE -ne 0 -or $origin -notmatch '^(https://github\.com/tigu77/tiguclaw(?:\.git)?|git@github\.com:tigu77/tiguclaw(?:\.git)?)$') {
    Die 'Existing folder is not the official tiguclaw checkout. It was not changed; choose another TIGUCLAW_DIR.'
  }
}
Write-Host "  git: $GitExe"

# ★**Node 가 없으면 여기서 멈추지 않는다** — sh 판과 같은 이유·같은 방식이다(2026-09-09).
#  `winget install` 을 부르지 않는다: 전역 변경이고, 무엇보다 **지울 때 같이 안 지워진다.**
#  대신 앱 폴더 안에 이 설치본 전용 Node 를 둔다: <설치폴더>\.node
#  ★서비스 등록(사용자 수준 예약작업)은 `bin/daemon.mjs` 가 `process.execPath` 를 굽기
#   때문에 저절로 이 Node 를 가리킨다 — 배선을 새로 만들 필요가 없다.
$NodeDir = Join-Path $Dir '.node'
$NeedNode = $false

function Test-NodeOk {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { return $false }
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { return $false }
  try { $maj = [int]((((node.exe --version) -replace '^v','') -split '\.')[0]) } catch { return $false }
  return ($maj -ge $MinNode)
}

function Install-PrivateNode {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  # 버전을 손으로 박지 않는다 — `latest-v<major>.x/SHASUMS256.txt` 가 파일 이름과 해시를 같이 준다.
  $base = "https://nodejs.org/dist/latest-v$LtsMajor.x"
  $tmp  = Join-Path ([System.IO.Path]::GetTempPath()) ("tiguclaw-node-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n"
    $line = $sums | Where-Object { $_ -match "node-v[\d.]+-win-$arch\.zip\s*$" } | Select-Object -First 1
    if (-not $line) { Die "No Node release found for this platform (win-$arch)." }
    $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
    $want  = $parts[0]; $file = $parts[1]
    Write-Host "   Downloading: $file"
    $zip = Join-Path $tmp $file
    Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
    # ★검증 실패는 «다시 시도» 가 아니라 중단이다 — 실행 파일을 받는 중이다.
    $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
    if ($got -ne $want.ToLower()) { Die "Node checksum mismatch — installation stopped.`n   expected: $want`n   actual:   $got" }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem -Path $tmp -Directory | Where-Object { $_.Name -like 'node-v*' } | Select-Object -First 1
    if (-not $inner) { Die "Could not find the folder inside the Node archive." }
    # ★**임시 자리에 둔다** (2026-09-09, 코드 리뷰). `install.sh` 는 같은 날 이 문제를
    #  고쳤는데 이 파일만 그대로였다 — clone 뒤에 받으면 받기가 어떤 이유로든 실패할 때
    #  (목록 404·다운로드 끊김·체크섬 불일치·압축 폴더 없음·실행 실패) **clone 된 폴더만
    #  남고**, 재실행은 «이미 설치돼 있습니다 → npx tiguclaw update» 로 막힌다. 그 사람은
    #  정의상 node·npx 가 없어서 온 사람이라 그 안내를 실행할 수 없다.
    #  ★clone 보다 먼저 받으면 실패해도 아직 아무것도 안 만들었으니 그냥 끝난다.
    $script:NodeStage = $inner.FullName
    $script:NodeStageTmp = $tmp
    if (-not (Test-Path (Join-Path $script:NodeStage 'node.exe'))) { Die "The downloaded Node has no node.exe." }
  } catch {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    throw
  }
  Write-Host "[v] Private node ready (moving it into the install folder)" -ForegroundColor Green
}

# 받아둔 것을 설치 폴더 안으로 옮기고 PATH 를 앞세운다 — clone 뒤에 부른다.
function Move-PrivateNode {
  New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
  Copy-Item -Path (Join-Path $script:NodeStage '*') -Destination $NodeDir -Recurse -Force
  Remove-Item -Recurse -Force $script:NodeStageTmp -ErrorAction SilentlyContinue
  $env:PATH = "$NodeDir;$env:PATH"
  if (-not (Test-NodeOk)) { Die "The private Node was installed but does not run ($NodeDir\node.exe)." }
  Write-Host "[v] Private node $(node.exe -v) — $NodeDir (your system was not touched)" -ForegroundColor Green
}

# A fresh PowerShell does not inherit the previous installer's process PATH.
if ($ExistingInstall -and (Test-Path -LiteralPath (Join-Path $NodeDir 'node.exe'))) {
  $env:PATH = "$NodeDir;$env:PATH"
}
if (Test-NodeOk) {
  Write-Host "[v] node $(node.exe -v) · git $((& $GitExe --version).Split(' ')[2])"
} else {
  if (Get-Command node.exe -ErrorAction SilentlyContinue) {
    Write-Host "! Your node is $(node.exe -v), but $MinNode or newer is required." -ForegroundColor Yellow
  } else {
    Write-Host "! Node.js is not installed ($MinNode or newer is required)." -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "  tiguclaw can download its own Node into this install folder only:"
  Write-Host "    $NodeDir   (about 50 MB to download · about 200 MB installed · no admin rights · system PATH untouched)"
  Write-Host "  Deleting the install folder removes it as well."
  Write-Host ""
  # ★묻는다 — 런타임을 받아 까는 일을 조용히 하지 않는다.
  # ★**값을 본다**(2026-09-09, 코드 리뷰). 종전 `-not $env:…` 는 «설정됐나» 만 봤고,
  #  PowerShell 은 비어 있지 않은 문자열을 전부 참으로 보므로 `0`·`false`·`no` 가 모두
  #  «묻지 말고 받아라» 였다 — 끄려고 0 을 넣은 사람이 정확히 반대를 얻는다.
  #  `install.sh` 는 같은 날 고쳤는데 이 파일만 그대로였다.
  if ($env:TIGUCLAW_AUTO_NODE -notmatch '^(1|true|yes|on|y)$') {
    $ans = Read-Host "  Download it? [Y/n]"
    # ★거절을 **넓게** 받는다 — 질문이 한국어인데 거절만 ASCII 2형태였다.
    #  애매하면 안 받는 쪽이 맞다: 잘못 멈추면 다시 돌리면 되고, 잘못 받으면 200MB 가
    #  이미 내려와 있다.
    if ($ans -match '^\s*(n|no|nope|nah|q|quit|0|false|아니|아니오|아니요|싫어|취소)\s*$') {
      Die "Installation stopped. Install Node $MinNode or newer (winget install OpenJS.NodeJS.LTS) and run this again."
    }
  }
  $NeedNode = $true
  Write-Host ""
  Write-Host "-> Downloading a private Node..." -ForegroundColor Cyan
  Install-PrivateNode          # ★clone 전에 받는다 — 실패해도 아무것도 안 남는다.
}

# ★npm 은 **npm.cmd** 로 부른다 (2026-08-19 실사고).
#  PowerShell 에서 `npm` 을 부르면 `npm.ps1` 이 잡히는데, 실행 정책이 기본 잠금인 윈도우에서는
#  그 파일을 **로드하지 못해** 설치가 통째로 멈춘다("이 시스템에서 스크립트를 실행할 수
#  없으므로 npm.ps1 파일을 로드할 수 없습니다"). `npm.cmd` 는 배치 파일이라 정책 대상이 아니다.
#  ★사용자에게 `Set-ExecutionPolicy` 를 시키지 않는다 — 설치 하나 하려고 시스템 보안 설정을
#   바꾸게 하는 건 우리가 할 말이 아니고, 우리가 부르는 방식만 바꾸면 되는 일이다.
# ★해석은 **전용 Node 를 깐 뒤**에 한다 (적대 검토 P2). 여기서 정하면 그 시점엔 전용 Node 가
#  아직 없어 `$Npm = "npm"` 으로 굳고, 나중에 Node 를 깔아도 그대로라 `npm.ps1` 을 잡는다 —
#  바로 위 주석이 막겠다고 적어둔 2026-08-19 사고가 그대로 재발한다.

# ★**여기 있던 버전 검사 3줄을 지웠다** (2026-09-09, 적대 검토 P1). 위 `Test-NodeOk` 가
#  이미 같은 판정을 하는데 옛 검사가 남아 **두 벌**이 됐고, 그게 치명적이었다: 이 줄에
#  도달하는 사람은 정의상 **node 가 없어서** 온 사람인데 `node --version` 을 맨몸으로 불렀다.
#  `$ErrorActionPreference='Stop'` 이라 CommandNotFound 로 죽고, 넘어가도 `[int]('')` 가 던지고,
#  0 이면 "지금 " 이라는 빈 자기모순 메시지로 죽는다 — **세 갈래 전부 clone 전에 중단**이라
#  윈도우에서 전용 Node 기능이 **0% 작동**했다.
#  ★함정을 몰라서가 아니다 — 42행의 같은 호출은 `try{}catch{}` 안에 있다. **새 갈래에서만**
#   빠뜨렸다. 같은 판단을 두 곳에 두면 한쪽이 낡는다.
#  (원래 이 자리가 막던 PowerShell 5.1 인용 함정은 `Test-NodeOk` 안으로 옮겨가 있다.)

# A verified stopped checkout resumes without pull/reset. A folder is not a completion marker.
Write-Host ""
if ($ExistingInstall) {
  Write-Host "-> Resuming existing checkout (settings are kept): $Dir"
} else {
  Write-Host "-> Downloading the code..."
  & $GitExe clone --quiet $RepoUrl $Dir
  if ($LASTEXITCODE -ne 0) { Die "git clone failed. Keep any partial folder for recovery or choose another TIGUCLAW_DIR and rerun." }
}
Set-Location $Dir

# ★전용 Node 는 clone 뒤에 받는다 — 폴더가 먼저 있으면 `git clone` 이 실패한다.
#  여기서 PATH 를 앞세우면 아래 npm·onboard·서비스 등록이 전부 이 Node 를 쓴다.
if ($NeedNode) { Move-PrivateNode }

# ★**안내하는 명령이 그 사람 손에서 실제로 돌아야 한다** (2026-09-09, 코드 리뷰).
#  전용 Node 는 이 프로세스 안에서만 PATH 에 오른다(프로필·setx 어디에도 안 남긴다 —
#  시스템을 안 건드린다는 약속이 그것이다). 그래서 아래 안내가 `npm ci` 라고 적으면
#  **그 사람 셸엔 npm 이 없다.** 문자열은 남는데 실행이 안 되는 상태였다.
#  `install.sh` 는 같은 날 고쳤는데 이 파일만 그대로였다.
if ($NeedNode) {
  $NpmShow  = Join-Path $NodeDir 'npm.cmd'
  $HowtoTail = "`n   (This install uses a private Node — to keep using it from your terminal, add this to your PATH:`n      `$env:PATH = '$NodeDir;' + `$env:PATH`n    Even without it, you can update from chat with /update.)"
} else {
  $NpmShow = 'npm.cmd'
  $HowtoTail = ''
}

# ★이제서야 npm 을 해석한다 — 전용 Node 를 깔았으면 그쪽 `npm.cmd` 가 잡혀야 한다(P2).
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source

Write-Host "-> Installing dependencies... (building native modules can take 1-2 minutes)"
# ★`--ignore-scripts=false` 를 **명시**한다 (2026-08-19 실사고). 사내 정책으로 npm 설정에
#  ignore-scripts=true 가 켜져 있으면 `npm ci` 는 **성공하는데** 네이티브 빌드가 아예 안 돌아
#  better_sqlite3.node 가 안 생긴다 -> 데몬이 부팅마다 죽는다. 전역 정책은 안 건드리고
#  이 호출에만 붙인다(사용자가 설치를 직접 시작했고, 이 제품은 네이티브 없이는 못 뜬다).
& $Npm ci --no-audit --no-fund --ignore-scripts=false
if ($LASTEXITCODE -ne 0) {
  Die @"
Dependency install failed.
   You may need the C++ build tools:
     winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools"
   Then retry:  cd $Dir; $NpmShow ci --ignore-scripts=false
"@
}

# ★설치가 "성공" 해도 **쓸 수 있는지는 별개다** (2026-08-19 실사고).
#  사내 정책으로 `ignore-scripts=true` 가 켜진 머신에서 `npm ci` 는 멀쩡히 성공하는데
#  네이티브 빌드 스크립트가 아예 안 돌아 `better_sqlite3.node` 가 안 생긴다. 그러면
#  설치는 끝난 것처럼 보이고 데몬은 **부팅할 때마다 죽는다**(실측: 6회 연속 크래시).
#  종료코드는 "명령이 실패했나" 지 "결과가 쓸 만한가" 가 아니다 — 열어봐야 안다.
#  ★우리 클린룸 검증(sync 스킬 §7)은 이미 이 확인을 하고 있었다. 정작 **사용자가 돌리는
#   스크립트**에만 없었다 — 우리 설치는 검증하고 사용자 설치는 안 하고 있었던 셈이다.
Write-Host "-> Checking native modules..."
# ★이 구간만 Continue (2026-10-16 재검토 2차 P4) - Windows PowerShell 5.1 은 Stop 아래서 **리디렉션한 네이티브 stderr**(`2>$null`)를
#  종료 오류로 바꾼다. 점검이 실제로 DB 를 열게 되면서 실패 때 stderr 가 나오고, 그러면 아래 rebuild·안내에 닿기 전에 스크립트가 죽는다.
#  판정은 종료코드($LASTEXITCODE)로 한다.
$ErrorActionPreference = 'Continue'
node.exe bin/check-native.cjs 2>$null
if ($LASTEXITCODE -ne 0) {
  # ★알려주고 끝내지 않는다 - **스스로 한 번 고쳐본다**(사용자가 명령을 외우게 하지 않는다).
  Write-Host "   A native module failed to load - rebuilding..."
  & $Npm rebuild better-sqlite3 --ignore-scripts=false 2>$null | Out-Null
  node.exe bin/check-native.cjs 2>$null
  if ($LASTEXITCODE -ne 0) {
    Die @"
Cannot load the SQLite native module - the daemon would crash on every start.

   The C++ build tools are required:
     winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools"
   Then:  cd $Dir; $NpmShow rebuild better-sqlite3
"@
  }
  Write-Host "   Native module repaired."
}
$ErrorActionPreference = 'Stop'

# ── onboard 로 넘김 (대화형) ────────────────────────────────────────────────
Write-Host ""
& $Npm run onboard
if ($LASTEXITCODE -ne 0) { Die "Setup is not finished. Settings are kept; rerun this installer after fixing the problem above." }
} catch {
  # Die 는 이미 안내를 찍었다. 그 밖의 오류(네트워크 끊김 등)는 날것의 PowerShell 오류 대신 한 줄로.
  if ("$_" -ne 'TIGUCLAW_DIE') {
    Write-Host "`n[X] Installation stopped: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "   If this is a network problem, check your connection and run the same command again."
  }
  # 파일로 실행했을 때만 종료 코드를 남긴다 — `irm | iex` 에서 exit 는 사용자 창을 닫는다.
  if ($PSCommandPath) { exit 1 }
}
