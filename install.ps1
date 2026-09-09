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

function Die($msg) { Write-Host "`n[X] $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== tiguclaw 설치 ===" -ForegroundColor Cyan
Write-Host "설치 위치: $Dir   (바꾸려면: `$env:TIGUCLAW_DIR='D:\tiguclaw')"
Write-Host ""

# ── 전제 ────────────────────────────────────────────────────────────────────
if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { Die "git 이 없습니다. 먼저 설치하세요: winget install Git.Git" }

# ★**Node 가 없으면 여기서 멈추지 않는다** — sh 판과 같은 이유·같은 방식이다(2026-09-09).
#  `winget install` 을 부르지 않는다: 전역 변경이고, 무엇보다 **지울 때 같이 안 지워진다.**
#  대신 앱 폴더 안에 이 설치본 전용 Node 를 둔다: <설치폴더>\.node
#  ★서비스 등록(사용자 수준 예약작업)은 `bin/daemon.mjs` 가 `process.execPath` 를 굽기
#   때문에 저절로 이 Node 를 가리킨다 — 배선을 새로 만들 필요가 없다.
$NodeDir = Join-Path $Dir '.node'
$NeedNode = $false

function Test-NodeOk {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  if (-not (Get-Command npm  -ErrorAction SilentlyContinue)) { return $false }
  try { $maj = [int]((((node --version) -replace '^v','') -split '\.')[0]) } catch { return $false }
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
    if (-not $line) { Die "이 플랫폼(win-$arch)용 Node 배포본을 목록에서 못 찾았습니다." }
    $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
    $want  = $parts[0]; $file = $parts[1]
    Write-Host "   받는 중: $file"
    $zip = Join-Path $tmp $file
    Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
    # ★검증 실패는 «다시 시도» 가 아니라 중단이다 — 실행 파일을 받는 중이다.
    $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
    if ($got -ne $want.ToLower()) { Die "Node 배포본 체크섬이 다릅니다 — 설치를 중단합니다.`n   기대: $want`n   실제: $got" }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem -Path $tmp -Directory | Where-Object { $_.Name -like 'node-v*' } | Select-Object -First 1
    if (-not $inner) { Die "Node 압축 안에서 폴더를 못 찾았습니다." }
    New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
    Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $NodeDir -Recurse -Force
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
  $env:PATH = "$NodeDir;$env:PATH"
  if (-not (Test-NodeOk)) { Die "전용 Node 를 설치했는데 실행되지 않습니다 ($NodeDir\node.exe)." }
  Write-Host "[v] 전용 node $(node -v) — $NodeDir (시스템은 안 건드렸습니다)" -ForegroundColor Green
}

if (Test-NodeOk) {
  Write-Host "[v] node $(node -v) · git $((git --version).Split(' ')[2])"
} else {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "! 지금 node 는 $(node -v) 인데 $MinNode 이상이 필요합니다." -ForegroundColor Yellow
  } else {
    Write-Host "! Node.js 가 없습니다 ($MinNode 이상이 필요합니다)." -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "  tiguclaw 전용 Node 를 이 설치 폴더 안에만 받을 수 있습니다:"
  Write-Host "    $NodeDir   (약 50MB · 관리자 권한 불필요 · 시스템 PATH 를 안 건드림)"
  Write-Host "  지울 때는 설치 폴더를 지우면 같이 사라집니다."
  Write-Host ""
  # ★묻는다 — 런타임을 받아 까는 일을 조용히 하지 않는다.
  if (-not $env:TIGUCLAW_AUTO_NODE) {
    $ans = Read-Host "  받을까요? [Y/n]"
    if ($ans -match '^(n|no)$') { Die "설치를 멈췄습니다. Node $MinNode 이상을 직접 설치한 뒤 다시 실행하세요 (winget install OpenJS.NodeJS.LTS)." }
  }
  $NeedNode = $true
}

# ★npm 은 **npm.cmd** 로 부른다 (2026-08-19 실사고).
#  PowerShell 에서 `npm` 을 부르면 `npm.ps1` 이 잡히는데, 실행 정책이 기본 잠금인 윈도우에서는
#  그 파일을 **로드하지 못해** 설치가 통째로 멈춘다("이 시스템에서 스크립트를 실행할 수
#  없으므로 npm.ps1 파일을 로드할 수 없습니다"). `npm.cmd` 는 배치 파일이라 정책 대상이 아니다.
#  ★사용자에게 `Set-ExecutionPolicy` 를 시키지 않는다 — 설치 하나 하려고 시스템 보안 설정을
#   바꾸게 하는 건 우리가 할 말이 아니고, 우리가 부르는 방식만 바꾸면 되는 일이다.
$Npm = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { "npm.cmd" } else { "npm" }

# 버전 판정은 PowerShell 안에서 한다 — node 에 **표현식을 넘기지 않는다**.
#  ★종전: `node -p 'process.versions.node.split(".")[0]'`. Windows PowerShell(5.1 계열)은
#   네이티브 명령에 인자를 넘길 때 **큰따옴표를 이스케이프하지 않는다.** 그래서 node.exe 가
#   `"` 를 인자 구분자로 먹고 `process.versions.node.split(.)[0]` 을 받아 SyntaxError 를 낸다.
#   그러면 이 줄이 빈 값이 되고 `[int]` 가 0 이 돼, **Node 24 를 깔아둔 사람에게**
#   "Node.js 20 이상이 필요합니다 (지금 v24.19.0)" 라는 **자기모순 메시지**로 설치가 멈춘다
#   (2026-08-19 실제 신고). PowerShell 7.3+ 는 동작이 바뀌어 안 터진다 = 기계마다 갈린다.
#  ★install.sh 의 같은 줄은 멀쩡하다 — bash 는 argv 를 그대로 넘겨 재파싱이 없다. 같은
#   코드가 셸에 따라 다르게 깨지는 자리라, 여기만 고친다.
$nodeMajor = [int]((((node --version) -replace '^v', '') -split '\.')[0])
if ($nodeMajor -lt $MinNode) { Die "Node.js $MinNode 이상이 필요합니다 (지금 $(node -v))." }
Write-Host "[v] node $(node -v)"

# ── 이미 있으면 덮지 않는다 — 업데이트는 update 의 일이다 ────────────────────
if (Test-Path $Dir) {
  if (Test-Path (Join-Path $Dir '.git')) {
    Die @"
$Dir 에 이미 설치돼 있습니다.
   업데이트는:  cd $Dir; npx tiguclaw update
   (그 명령이 정지 -> 의존성 -> 재빌드 -> 기동을 순서대로 합니다.
    ★npm ci 를 직접 돌리지 마세요 — 데몬이 파일을 잡고 있으면 설치가 깨집니다.)
"@
  }
  Die "$Dir 이 이미 있는데 tiguclaw 설치본이 아닙니다. 다른 경로를 쓰세요: `$env:TIGUCLAW_DIR='D:\tiguclaw'"
}

# ── 받기 · 설치 ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "-> 코드 받는 중..."
git clone --quiet $RepoUrl $Dir
if ($LASTEXITCODE -ne 0) { Die "clone 실패 — 네트워크나 접근 권한을 확인하세요." }
Set-Location $Dir

# ★전용 Node 는 clone 뒤에 받는다 — 폴더가 먼저 있으면 `git clone` 이 실패한다.
#  여기서 PATH 를 앞세우면 아래 npm·onboard·서비스 등록이 전부 이 Node 를 쓴다.
if ($NeedNode) {
  Write-Host ""
  Write-Host "-> 전용 Node 준비 중..." -ForegroundColor Cyan
  Install-PrivateNode
}

Write-Host "-> 의존성 설치 중... (네이티브 모듈 빌드로 1~2분 걸릴 수 있습니다)"
# ★`--ignore-scripts=false` 를 **명시**한다 (2026-08-19 실사고). 사내 정책으로 npm 설정에
#  ignore-scripts=true 가 켜져 있으면 `npm ci` 는 **성공하는데** 네이티브 빌드가 아예 안 돌아
#  better_sqlite3.node 가 안 생긴다 -> 데몬이 부팅마다 죽는다. 전역 정책은 안 건드리고
#  이 호출에만 붙인다(사용자가 설치를 직접 시작했고, 이 제품은 네이티브 없이는 못 뜬다).
& $Npm ci --no-audit --no-fund --ignore-scripts=false
if ($LASTEXITCODE -ne 0) {
  Die @"
의존성 설치 실패.
   C++ 빌드 도구가 필요할 수 있습니다:
     winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools"
   설치 후 다시:  cd $Dir; npm ci
"@
}

# ★설치가 "성공" 해도 **쓸 수 있는지는 별개다** (2026-08-19 실사고).
#  사내 정책으로 `ignore-scripts=true` 가 켜진 머신에서 `npm ci` 는 멀쩡히 성공하는데
#  네이티브 빌드 스크립트가 아예 안 돌아 `better_sqlite3.node` 가 안 생긴다. 그러면
#  설치는 끝난 것처럼 보이고 데몬은 **부팅할 때마다 죽는다**(실측: 6회 연속 크래시).
#  종료코드는 "명령이 실패했나" 지 "결과가 쓸 만한가" 가 아니다 — 열어봐야 안다.
#  ★우리 클린룸 검증(sync 스킬 §7)은 이미 이 확인을 하고 있었다. 정작 **사용자가 돌리는
#   스크립트**에만 없었다 — 우리 설치는 검증하고 사용자 설치는 안 하고 있었던 셈이다.
Write-Host "-> 네이티브 모듈 확인 중..."
node -e "require('better-sqlite3')" 2>$null
if ($LASTEXITCODE -ne 0) {
  # ★알려주고 끝내지 않는다 - **스스로 한 번 고쳐본다**(사용자가 명령을 외우게 하지 않는다).
  Write-Host "   네이티브 모듈이 안 열립니다 - 다시 빌드합니다..."
  & $Npm rebuild better-sqlite3 --ignore-scripts=false 2>$null | Out-Null
  node -e "require('better-sqlite3')" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Die @"
SQLite 네이티브 모듈을 열 수 없습니다 - 이 상태로는 데몬이 부팅마다 죽습니다.

   C++ 빌드 도구가 필요합니다:
     winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools"
   그 뒤:  cd $Dir; npm rebuild better-sqlite3
"@
  }
  Write-Host "   네이티브 모듈 복구 완료."
}

# ── onboard 로 넘김 (대화형) ────────────────────────────────────────────────
Write-Host ""
& $Npm run onboard
