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
# 자동 설치할 때 고를 LTS 계열 — 네이티브 미리빌드가 LTS 를 따라간다(README 와 같은 근거).
LTS_MAJOR="${TIGUCLAW_NODE_MAJOR:-22}"
NEED_NODE=0

say() { printf '%s\n' "$*"; }
die() { printf '\n🔴 %s\n' "$*" >&2; exit 1; }

say ""
say "=== tiguclaw 설치 ==="
say "설치 위치: $DIR   (바꾸려면: TIGUCLAW_DIR=/원하는/경로)"
say ""

# ── 전제 ────────────────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || die "git 이 없습니다. 먼저 설치하세요."

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

# ★**Node 가 없으면 여기서 멈추지 않는다** (2026-09-09 정태님: *"일반 사용자들도 설치하기
#  시작했거든"*). 이 제품의 정체성은 «당신의 상시 AI 비서» 이고 그 대상은 개발자가 아니다.
#  «먼저 Node 20 이상을 설치하세요» 는 거기서 벽이다.
#
# ★그래도 **시스템은 안 건드린다.** `brew install node`·`apt install`·`winget install` 은
#  전역 변경이고 관리자 권한이 필요할 수 있으며, 무엇보다 **지울 때 같이 안 지워진다.**
#  대신 앱 폴더 안에 **이 설치본 전용 Node** 를 둔다:  <설치폴더>/.node
#  판정 3줄을 그대로 만족한다 — 지울 때 같이 지워지고 · 깨질 때 혼자 깨지고 ·
#  폴더만 보면 누구 것인지 안다. PATH 오염 0, 관리자 권한 0, 제거는 폴더 삭제.
#
# ★서비스 등록이 저절로 따라온다: `bin/daemon.mjs` 가 유닛에 굽는 것은 `process.execPath`
#  이므로, 아래에서 PATH 를 앞세워 onboard 를 돌리면 launchd/systemd 가 이 Node 를 가리킨다.
#  (배선을 새로 만들 필요가 없다 — 이미 그렇게 돼 있다.)
NODE_DIR="$DIR/.node"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  command -v npm  >/dev/null 2>&1 || return 1
  _maj=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  [ "${_maj:-0}" -ge "$MIN_NODE" ] 2>/dev/null
}

# 공식 배포본을 받아 <설치폴더>/.node 에 푼다. **체크섬을 검증한다** — 실행 파일이다.
fetch_node() {
  _os=$(uname -s); _arch=$(uname -m)
  case "$_os" in
    Darwin) _o=darwin ;;
    Linux)  _o=linux ;;
    *) die "이 운영체제($_os)에는 자동 설치가 없습니다 — Node ${MIN_NODE} 이상을 직접 설치해 주세요 (https://nodejs.org)." ;;
  esac
  case "$_arch" in
    arm64|aarch64) _a=arm64 ;;
    x86_64|amd64)  _a=x64 ;;
    *) die "이 아키텍처($_arch)에는 자동 설치가 없습니다 — https://nodejs.org 에서 직접 받아 주세요." ;;
  esac

  # ★버전을 **손으로 박지 않는다.** 박아두면 낡고, 낡은 줄은 아무도 안 고친다.
  #  `latest-v<major>.x/SHASUMS256.txt` 는 그 LTS 계열의 **현재 파일 이름과 해시**를
  #  한 번에 준다 — 목록에서 우리 것을 골라내면 버전은 저절로 따라온다.
  _base="https://nodejs.org/dist/latest-v${LTS_MAJOR}.x"
  _tmp=$(mktemp -d) || die "임시 폴더를 만들 수 없습니다."
  # ★`.tar.gz` 를 쓴다 — `.tar.xz` 는 리눅스 기본 tar 에 xz-utils 가 있어야 풀린다.
  curl -fsSL "$_base/SHASUMS256.txt" -o "$_tmp/SHASUMS256.txt" \
    || die "Node 배포 목록을 못 받았습니다 — 네트워크를 확인하세요 ($_base)."
  _file=$(grep -E "node-v[0-9.]+-${_o}-${_a}\.tar\.gz\$" "$_tmp/SHASUMS256.txt" | awk '{print $2}' | head -1)
  [ -n "$_file" ] || die "이 플랫폼(${_o}-${_a})용 Node 배포본을 목록에서 못 찾았습니다."
  _want=$(grep " $_file\$" "$_tmp/SHASUMS256.txt" | awk '{print $1}' | head -1)

  say "   받는 중: $_file"
  curl -fsSL "$_base/$_file" -o "$_tmp/$_file" || die "Node 내려받기 실패 ($_base/$_file)."

  if command -v sha256sum >/dev/null 2>&1; then _got=$(sha256sum "$_tmp/$_file" | awk '{print $1}')
  elif command -v shasum   >/dev/null 2>&1; then _got=$(shasum -a 256 "$_tmp/$_file" | awk '{print $1}')
  else die "sha256 도구가 없어 무결성을 확인할 수 없습니다 — 검증 못 한 실행 파일은 설치하지 않습니다."
  fi
  # ★검증 실패는 «다시 시도» 가 아니라 **중단**이다. 실행 파일을 받는 중이다.
  [ "$_got" = "$_want" ] || die "Node 배포본 체크섬이 다릅니다 — 설치를 중단합니다.
   기대: $_want
   실제: $_got"

  # ★**임시 자리에 푼다** (2026-09-09, 적대 검토 P3). 종전엔 clone 뒤에 받아서, 받기가
  #  어떤 이유로든 실패하면(목록 404·다운로드 끊김·체크섬 불일치·미지원 OS/arch·tar 실패)
  #  **clone 된 폴더만 남았다.** 그 사람은 Node 가 없어서 온 사람이라 안내하던 탈출구
  #  (`npx tiguclaw update`)를 실행할 수도 없었고, 재실행하면 «이미 설치돼 있습니다» 로
  #  막혔다 — 유일한 길 `rm -rf` 는 어디에도 안 적혀 있었다. 이 파일 머리말이 *"반쯤
  #  설치된 상태로 두지 않는다"* 고 적어둔 바로 그 상태다.
  #  ★그래서 **clone 보다 먼저** 받는다. 실패하면 아직 아무것도 안 만들었으니 그냥 끝난다.
  NODE_STAGE="$_tmp/node"
  mkdir -p "$NODE_STAGE" || die "임시 폴더를 만들 수 없습니다."
  tar -xzf "$_tmp/$_file" -C "$NODE_STAGE" --strip-components=1 \
    || die "Node 압축을 풀지 못했습니다."
  rm -f "$_tmp/$_file"
  "$NODE_STAGE/bin/node" -v >/dev/null 2>&1 \
    || die "받은 Node 가 이 기계에서 실행되지 않습니다 ($_os-$_a)."
  say "✓ 전용 node $("$NODE_STAGE/bin/node" -v) 준비됨 (설치 폴더로 옮깁니다)"
}

# 받아둔 것을 설치 폴더 안으로 옮기고 PATH 를 앞세운다 — clone 뒤에 부른다.
place_node() {
  mv "$NODE_STAGE" "$NODE_DIR" || die "$NODE_DIR 로 옮기지 못했습니다."
  rm -rf "$(dirname "$NODE_STAGE")"
  PATH="$NODE_DIR/bin:$PATH"; export PATH
  node_ok || die "전용 Node 를 설치했는데 실행되지 않습니다 ($NODE_DIR/bin/node)."
  say "✓ 전용 node $(node -v) — $NODE_DIR (시스템은 안 건드렸습니다)"
}

if node_ok; then
  say "✓ node $(node -v) · git $(git --version | awk '{print $3}')"
else
  if command -v node >/dev/null 2>&1; then
    say "! 지금 node 는 $(node -v) 인데 ${MIN_NODE} 이상이 필요합니다."
  else
    say "! Node.js 가 없습니다 (${MIN_NODE} 이상이 필요합니다)."
  fi
  say ""
  say "  tiguclaw 전용 Node 를 **이 설치 폴더 안에만** 받을 수 있습니다:"
  # ★숫자를 정직하게 (적대 검토 P8): 내려받기 ≈50MB 지만 **푼 뒤 디스크는 ≈200MB**
  #  (실측 darwin-arm64 187MB · 파일 4,750개). 받는 양만 말하면 절반만 말한 것이다.
  say "    $NODE_DIR   (내려받기 약 50MB · 설치 후 약 200MB · 관리자 권한 불필요 · 시스템 PATH 를 안 건드림)"
  say "  지울 때는 설치 폴더를 지우면 같이 사라집니다."
  say ""
  # ★**묻는다.** 런타임을 받아 까는 일을 조용히 하지 않는다. 비대화형(파이프·CI)에서는
  #  묻지 못하므로, 그때는 명시 동의(TIGUCLAW_AUTO_NODE=1)가 있을 때만 진행한다.
  # ★**값을 본다** (적대 검토 P7). 종전엔 «설정됐나» 만 봐서 `TIGUCLAW_AUTO_NODE=0`·
  #  `false`·`no` 가 전부 «묻지 말고 받아라» 가 됐다 — 끄려고 0 을 넣은 사람이 정확히
  #  반대를 얻는다.
  _auto=$(printf '%s' "${TIGUCLAW_AUTO_NODE:-}" | tr 'A-Z' 'a-z')
  case "$_auto" in 0|false|no|off|n) _auto="" ;; esac
  if [ -z "$_auto" ]; then
    if [ -t 0 ]; then
      printf '  받을까요? [Y/n] '; read -r _ans || _ans=""
    elif { : < /dev/tty; } 2>/dev/null; then
      printf '  받을까요? [Y/n] '; read -r _ans < /dev/tty || _ans=""
    else
      die "Node ${MIN_NODE} 이상이 필요합니다.
   직접 설치: https://nodejs.org
   또는 전용 Node 를 자동으로 받으려면:  TIGUCLAW_AUTO_NODE=1 로 다시 실행하세요."
    fi
    # ★거절을 **넓게** 받는다 (2026-09-09, 적대 검토 P6). 종전 `n|N|no|NO` 는 실측으로
    #  `No`·`nO`·`nope`·`아니오`·`아니요` 를 전부 **승낙**으로 읽었다 — 질문이 한국어이고
    #  대상이 비개발자인데 거절만 ASCII 4형태였다. 같은 판단을 하는 `install.ps1` 은
    #  `-match` 가 대소문자를 무시해 `No` 를 제대로 막았다(두 곳이 다르게 구현돼 있었다).
    #  ★애매하면 **안 받는 쪽**이 맞다: 잘못 멈추면 다시 돌리면 되고, 잘못 받으면 원치
    #   않은 50MB 다운로드가 이미 끝나 있다.
    _lower=$(printf '%s' "${_ans:-y}" | tr 'A-Z' 'a-z')
    case "$_lower" in
      n|no|nope|nah|q|quit|0|false|아니|아니오|아니요|싫어|취소)
        die "설치를 멈췄습니다. Node ${MIN_NODE} 이상을 직접 설치한 뒤 다시 실행하세요 (https://nodejs.org)." ;;
    esac
  fi
  say ""
  say "→ 전용 Node 준비 중…"
  fetch_node          # ★clone 전에 받는다 — 실패해도 아무것도 안 남는다(P3).
  NEED_NODE=1
fi

# ── 받기 · 설치 ─────────────────────────────────────────────────────────────
say ""
say "→ 코드 받는 중…"
git clone --quiet "$REPO_URL" "$DIR" || die "clone 실패 — 네트워크나 접근 권한을 확인하세요."
cd "$DIR"

# 받아둔 전용 Node 를 설치 폴더 안으로 옮긴다(폴더가 먼저 있으면 clone 이 실패하므로 여기서).
# 여기서 PATH 를 앞세우면 아래 npm·onboard·서비스 등록이 전부 이 Node 를 쓴다.
if [ "$NEED_NODE" = "1" ]; then place_node; fi

# ★**안내하는 명령이 그 사람 손에서 실제로 돌아야 한다** (2026-09-09, 적대 검토 P5).
#  전용 Node 는 이 스크립트 프로세스 안에서만 PATH 에 오른다(프로필·setx 어디에도 안 남긴다
#  — 시스템을 안 건드린다는 약속이 그것이다). 그래서 아래 안내가 `npm run onboard` 라고
#  적으면 **그 사람 셸엔 npm 이 없다.** 문자열은 남는데 실행이 안 되는 상태였다.
#  절대경로로 적는다 — 붙여넣으면 그냥 된다.
if [ "$NEED_NODE" = "1" ]; then
  NPM_CMD="$NODE_DIR/bin/npm"
  HOWTO_TAIL="
   (이 설치본은 전용 Node 를 씁니다 — 터미널에서 계속 쓰시려면 PATH 에 다음을 더하세요:
      export PATH=\"$NODE_DIR/bin:\$PATH\"
    안 더해도 채팅에서 /update 로 업데이트됩니다.)"
else
  NPM_CMD="npm"
  HOWTO_TAIL=""
fi

say "→ 의존성 설치 중… (네이티브 모듈 빌드로 1~2분 걸릴 수 있습니다)"
# ★`--ignore-scripts=false` 를 **명시**한다 (2026-08-19 실사고). 사내 정책으로 npm 설정에
#  ignore-scripts=true 가 켜져 있으면 `npm ci` 는 **성공하는데** 네이티브 빌드가 아예 안 돌아
#  better_sqlite3.node 가 안 생긴다 → 데몬이 부팅마다 죽는다. 전역 정책은 안 건드리고
#  이 호출에만 붙인다(사용자가 설치를 직접 시작했고, 이 제품은 네이티브 없이는 못 뜬다).
if ! npm ci --no-audit --no-fund --ignore-scripts=false; then
  die "의존성 설치 실패.
   빌드 도구가 필요할 수 있습니다 — Linux: build-essential + python3 / macOS: xcode-select --install
   설치 후 다시:  cd $DIR && $NPM_CMD ci"
fi

# ★설치가 "성공" 해도 **쓸 수 있는지는 별개다** (2026-08-19 실사고 — 윈도우).
#  `ignore-scripts=true`(사내 정책 등)면 `npm ci` 는 성공하는데 네이티브 빌드가 안 돌아
#  바인딩이 안 생긴다. 설치는 끝난 것처럼 보이고 데몬은 부팅마다 죽는다(실측 6회 연속).
#  종료코드는 "명령이 실패했나" 지 "결과가 쓸 만한가" 가 아니다 — 열어봐야 안다.
say "→ 네이티브 모듈 확인 중…"
if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
  # ★알려주고 끝내지 않는다 — **스스로 한 번 고쳐본다**(사용자가 명령을 외우게 하지 않는다).
  say "   네이티브 모듈이 안 열립니다 — 다시 빌드합니다…"
  npm rebuild better-sqlite3 --ignore-scripts=false >/dev/null 2>&1 || true
fi
if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
  die "SQLite 네이티브 모듈을 열 수 없습니다 — 이 상태로는 데몬이 부팅마다 죽습니다.
   빌드 도구가 필요합니다 — Linux: build-essential + python3 / macOS: xcode-select --install
   그 뒤:  cd $DIR && $NPM_CMD rebuild better-sqlite3"
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
  "$NPM_CMD" run onboard && exit 0
elif { : < /dev/tty; } 2>/dev/null; then
  "$NPM_CMD" run onboard < /dev/tty && exit 0
fi

say ""
say "✅ 코드와 의존성은 준비됐습니다 — 설정만 남았습니다."
say ""
say "   cd $DIR && $NPM_CMD run onboard"
say ""
say "   (LLM 선택·키 입력·서비스 등록·검증을 마법사가 안내합니다.)$HOWTO_TAIL"
say ""
