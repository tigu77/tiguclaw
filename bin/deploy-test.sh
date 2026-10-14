#!/bin/sh
# 테스트돌쇠 배포 — **개발 레포의 커밋된 HEAD** 를 별도 작업 트리에서 빌드해 테스트돌쇠(처음 설치한 사용자 재현)로 띄운다.
#
# ★왜 별도 작업 트리인가 (2026-10-14 정태님: «테스트돌쇠도 공개 버전 말고 개발 레포 빌드로»):
#  돌쇠와 `dist` 를 같이 쓰면 돌쇠를 배포할 때마다 **돌고 있는 테스트돌쇠의 코드가 섞인다**(나중에 불리는 모듈만 새 판).
#  작업 트리는 커밋된 HEAD 만 담으니 «무엇을 시험하나» 가 커밋 하나로 정해진다(미커밋 변경은 안 들어간다).
# ★대상은 박아서 넘긴다 — deploy-dev.sh 와 같은 이유(셸 env 가 새면 엉뚱한 인스턴스를 겨눈다).
#  홈·라벨·포트는 `docs/dev/instances.md` 표와 같아야 한다.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WT="$HOME/work/tiguclaw-test"
HOME_DIR="$HOME/work/tiguclaw-home"
LABEL="com.tiguclaw.install"
PORT=17011
[ -d "$WT/.git" ] || [ -f "$WT/.git" ] || { echo "🔴 작업 트리가 없습니다: git -C \"$REPO\" worktree add --detach \"$WT\" HEAD"; exit 1; }
[ -f "$HOME_DIR/.env" ] || { echo "🔴 테스트돌쇠 홈이 없습니다: $HOME_DIR/.env"; exit 1; }
SHA=$(git -C "$REPO" rev-parse HEAD)
echo "대상: tree=$WT home=$HOME_DIR bridge=$PORT service=$LABEL commit=$(git -C "$REPO" rev-parse --short HEAD)"
OLD_LOCK=$(git -C "$WT" rev-parse HEAD:package-lock.json 2>/dev/null || echo none)
git -C "$WT" checkout -q --detach "$SHA"
NEW_LOCK=$(git -C "$WT" rev-parse HEAD:package-lock.json)
cd "$WT"
# 의존성은 잠금 파일이 바뀌었을 때만 다시 깐다(매번 깔면 1~2분).
if [ "$OLD_LOCK" != "$NEW_LOCK" ] || [ ! -d node_modules ]; then npm ci --no-audit --no-fund --ignore-scripts=false; fi
# 네이티브 모듈을 실제로 열어 본다 — install.sh 와 같은 규칙(사내 정책 ignore-scripts 면 ci 는 성공해도 SQLite 가 안 열린다).
if ! node -e "require('better-sqlite3')(':memory:').close()" >/dev/null 2>&1; then
  echo "네이티브 모듈이 안 열립니다 — 다시 빌드합니다…"
  npm rebuild better-sqlite3 --ignore-scripts=false >/dev/null 2>&1 || true
  node -e "require('better-sqlite3')(':memory:').close()" || { echo "🔴 better-sqlite3 를 열 수 없습니다"; exit 1; }
fi
npm run build:prod
env -u HTTP_BRIDGE_TOKEN TIGUCLAW_HOME="$HOME_DIR" HTTP_BRIDGE_PORT="$PORT" TIGUCLAW_SERVICE_LABEL="$LABEL" node bin/deploy-guard.mjs
# 서비스가 이 작업 트리를 가리키지 않으면(첫 전환) 다시 등록한다 — 아니면 재시작만.
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ -f "$PLIST" ] && grep -q "$WT/dist/src/index.js" "$PLIST"; then
  env -u HTTP_BRIDGE_PORT TIGUCLAW_HOME="$HOME_DIR" TIGUCLAW_RUNTIME=built TIGUCLAW_SERVICE_LABEL="$LABEL" node bin/daemon.mjs restart
else
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  env -u HTTP_BRIDGE_PORT TIGUCLAW_HOME="$HOME_DIR" TIGUCLAW_RUNTIME=built TIGUCLAW_SERVICE_LABEL="$LABEL" node bin/daemon.mjs install
fi
