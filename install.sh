#!/bin/sh
# tiguclaw 한 줄 설치 (macOS · Linux)
#
#   curl -fsSL https://raw.githubusercontent.com/tigu77/tiguclaw/main/install.sh | sh
#
# 하는 일: 전제 확인 → clone → npm ci → onboard 로 넘김.
# 하지 않는 일: 설정을 대신 정하지 않는다(대화형 onboard 가 그 자리다).
#
# ★`| sh` 는 stdin 이 **파이프**다 — 그대로 onboard 를 부르면 질문을 읽을 수 없어
#  마법사가 조용히 헛돈다. 그래서 아래에서 /dev/tty 를 되찾아 넘긴다(없으면 다음
#  명령을 안내하고 멈춘다 — 반쯤 설치된 상태로 두지 않는다).
set -eu

REPO_URL="https://github.com/tigu77/tiguclaw.git"
DIR="${TIGUCLAW_DIR:-$HOME/tiguclaw}"
MIN_NODE=20

say() { printf '%s\n' "$*"; }
die() { printf '\n🔴 %s\n' "$*" >&2; exit 1; }

say ""
say "=== tiguclaw 설치 ==="
say "설치 위치: $DIR   (바꾸려면: TIGUCLAW_DIR=/원하는/경로)"
say ""

# ── 전제 ────────────────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || die "git 이 없습니다. 먼저 설치하세요."
command -v node >/dev/null 2>&1 || die "Node.js 가 없습니다 — ${MIN_NODE} 이상이 필요합니다 (https://nodejs.org)."
command -v npm >/dev/null 2>&1 || die "npm 이 없습니다. Node.js 설치를 확인하세요."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge "$MIN_NODE" ] || die "Node.js ${MIN_NODE} 이상이 필요합니다 (지금 $(node -v))."
say "✓ node $(node -v) · git $(git --version | awk '{print $3}')"

# ── 이미 있으면 덮지 않는다 — 업데이트는 update 의 일이다 ────────────────────
if [ -e "$DIR" ]; then
  if [ -d "$DIR/.git" ]; then
    die "$DIR 에 이미 설치돼 있습니다.
   업데이트는:  cd $DIR && npx tiguclaw update
   (그 명령이 정지 → 의존성 → 재빌드 → 기동을 순서대로 합니다.)"
  fi
  die "$DIR 이 이미 있는데 tiguclaw 설치본이 아닙니다. 다른 경로를 쓰세요:
   TIGUCLAW_DIR=~/tiguclaw2 curl -fsSL <위 URL> | sh"
fi

# ── 받기 · 설치 ─────────────────────────────────────────────────────────────
say ""
say "→ 코드 받는 중…"
git clone --quiet "$REPO_URL" "$DIR" || die "clone 실패 — 네트워크나 접근 권한을 확인하세요."
cd "$DIR"

say "→ 의존성 설치 중… (네이티브 모듈 빌드로 1~2분 걸릴 수 있습니다)"
if ! npm ci --no-audit --no-fund; then
  die "의존성 설치 실패.
   빌드 도구가 필요할 수 있습니다 — Linux: build-essential + python3 / macOS: xcode-select --install
   설치 후 다시:  cd $DIR && npm ci"
fi

# ★설치가 "성공" 해도 **쓸 수 있는지는 별개다** (2026-08-19 실사고 — 윈도우).
#  `ignore-scripts=true`(사내 정책 등)면 `npm ci` 는 성공하는데 네이티브 빌드가 안 돌아
#  바인딩이 안 생긴다. 설치는 끝난 것처럼 보이고 데몬은 부팅마다 죽는다(실측 6회 연속).
#  종료코드는 "명령이 실패했나" 지 "결과가 쓸 만한가" 가 아니다 — 열어봐야 안다.
say "→ 네이티브 모듈 확인 중…"
if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
  ig=$(npm config get ignore-scripts 2>/dev/null || echo "")
  if [ "$ig" = "true" ]; then
    die "설치는 됐지만 SQLite 네이티브 모듈을 열 수 없습니다 — 이 상태로는 데몬이 부팅마다 죽습니다.
   ★원인이 보입니다: npm 설정 ignore-scripts=true 가 켜져 있어 네이티브 빌드가 안 돌았습니다.
     이 폴더에만 풀어 주세요:
       cd $DIR && echo 'ignore-scripts=false' >> .npmrc && npm rebuild better-sqlite3 --ignore-scripts=false"
  fi
  die "설치는 됐지만 SQLite 네이티브 모듈을 열 수 없습니다 — 이 상태로는 데몬이 부팅마다 죽습니다.
   빌드 도구가 필요할 수 있습니다 — Linux: build-essential + python3 / macOS: xcode-select --install
   그 뒤:  cd $DIR && npm rebuild better-sqlite3"
fi

# ── onboard 로 넘김 (대화형) ────────────────────────────────────────────────
#
# ★터미널이 **있는지**가 아니라 **열리는지**로 판정한다 (실측 2026-08-11).
#  종전엔 `[ -r /dev/tty ]` 로 갈랐는데, 제어 터미널이 없는 환경(CI·컨테이너·
#  일부 SSH)에서 그 검사는 **true 를 주고 실제 열기는 실패**한다
#  (`/dev/tty: Device not configured`). 그러면 exec 가 죽으면서 안내문도 못 뿌리고
#  **종료코드 0 으로 조용히** 끝났다 — 의존성은 깔렸는데 다음 할 일을 아무도 모르는
#  상태. 존재 확인은 판정이 아니다. 열어보고 갈라야 한다.
#
# 그래서 `exec` 도 쓰지 않는다 — 껍데기를 남겨 둬야 실패했을 때 안내를 낼 수 있다.
say ""
if [ -t 0 ]; then
  npm run onboard && exit 0
elif { : < /dev/tty; } 2>/dev/null; then
  npm run onboard < /dev/tty && exit 0
fi

say ""
say "✅ 코드와 의존성은 준비됐습니다 — 설정만 남았습니다."
say ""
say "   cd $DIR && npm run onboard"
say ""
say "   (LLM 선택·키 입력·서비스 등록·검증을 마법사가 안내합니다.)"
say ""
