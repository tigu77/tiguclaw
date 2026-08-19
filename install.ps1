# tiguclaw 한 줄 설치 (Windows / PowerShell)
#
#   irm https://raw.githubusercontent.com/tigu77/tiguclaw/main/install.ps1 | iex
#
# 하는 일: 전제 확인 → clone → npm ci → onboard 로 넘김.
# 하지 않는 일: 설정을 대신 정하지 않는다(대화형 onboard 가 그 자리다).
#
# ★`irm | iex` 는 현재 콘솔에서 실행되므로 stdin 은 살아 있다(sh 판과 다른 점).
#  대신 여기선 **관리자 권한을 요구하지 않는다** — 데몬 등록이 HKCU Run 키라서다.

$ErrorActionPreference = 'Stop'

$RepoUrl  = 'https://github.com/tigu77/tiguclaw.git'
$Dir      = if ($env:TIGUCLAW_DIR) { $env:TIGUCLAW_DIR } else { Join-Path $env:USERPROFILE 'tiguclaw' }
$MinNode  = 20

function Die($msg) { Write-Host "`n[X] $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== tiguclaw 설치 ===" -ForegroundColor Cyan
Write-Host "설치 위치: $Dir   (바꾸려면: `$env:TIGUCLAW_DIR='D:\tiguclaw')"
Write-Host ""

# ── 전제 ────────────────────────────────────────────────────────────────────
if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { Die "git 이 없습니다. 먼저 설치하세요: winget install Git.Git" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js 가 없습니다 — $MinNode 이상이 필요합니다: winget install OpenJS.NodeJS.LTS" }
if (-not (Get-Command npm  -ErrorAction SilentlyContinue)) { Die "npm 이 없습니다. Node.js 설치를 확인하세요." }

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

Write-Host "-> 의존성 설치 중... (네이티브 모듈 빌드로 1~2분 걸릴 수 있습니다)"
# ★`--ignore-scripts=false` 를 **명시**한다 (2026-08-19 실사고). 사내 정책으로 npm 설정에
#  ignore-scripts=true 가 켜져 있으면 `npm ci` 는 **성공하는데** 네이티브 빌드가 아예 안 돌아
#  better_sqlite3.node 가 안 생긴다 -> 데몬이 부팅마다 죽는다. 전역 정책은 안 건드리고
#  이 호출에만 붙인다(사용자가 설치를 직접 시작했고, 이 제품은 네이티브 없이는 못 뜬다).
npm ci --no-audit --no-fund --ignore-scripts=false
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
  npm rebuild better-sqlite3 --ignore-scripts=false 2>$null | Out-Null
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
npm run onboard
