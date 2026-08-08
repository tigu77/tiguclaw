#!/bin/sh
# 개발 데몬(tiguclaw-dev) 배포 — **대상을 명시**한다.
#
# ★왜 필요한가 (2026-08-07): 개발자 역할 데몬(별도 인스턴스)이 여기서 `npm run deploy` 를
#  돌리면 **자기 env 를 물려준다**. deploy-guard 는 `HTTP_BRIDGE_PORT`, daemon.mjs 는
#  `TIGUCLAW_HOME` 을 보므로, 교체 대상이 아니라 **자기 자신**을 검사·재시작하게 된다.
#  실제로 그렇게 걸렸다 — 개발자 데몬이 자기 세션이 진행 중이라며 스스로를 막았다.
#
#  그래서 이 스크립트는 상속을 끊고 개발 홈·포트를 **박아서** 넘긴다. 사람이 손으로
#  `npm run deploy` 를 치는 경우와 결과가 같고(같은 홈), 개발자 데몬이 부를 때만 달라진다.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
HOME_DIR="$REPO/tiguclaw-dev"
PORT=$(grep -m1 '^HTTP_BRIDGE_PORT=' "$HOME_DIR/.env" | cut -d= -f2 | tr -d ' \r')
[ -n "$PORT" ] || { echo "🔴 $HOME_DIR/.env 에서 HTTP_BRIDGE_PORT 를 못 찾음"; exit 1; }
# ★서비스 라벨도 상속을 끊는다. 개발자 데몬 홈의 `TIGUCLAW_SERVICE_LABEL`(=install)이
#  새어 들어와 `launchctl kickstart com.tiguclaw.install` 로 엉뚱한 서비스를 겨눴다
#  (실측: "Could not find service ... 501"). dev .env 에 값이 있으면 그걸, 없으면 기본값.
LABEL=$(grep -m1 '^TIGUCLAW_SERVICE_LABEL=' "$HOME_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d ' \r')
[ -n "$LABEL" ] || LABEL="com.tiguclaw.daemon"
echo "대상: home=$HOME_DIR bridge=$PORT service=$LABEL"
npm run build:prod
env TIGUCLAW_HOME="$HOME_DIR" HTTP_BRIDGE_PORT="$PORT" TIGUCLAW_SERVICE_LABEL="$LABEL" node bin/deploy-guard.mjs
env TIGUCLAW_HOME="$HOME_DIR" HTTP_BRIDGE_PORT="$PORT" TIGUCLAW_SERVICE_LABEL="$LABEL" node bin/daemon.mjs restart
