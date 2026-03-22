#!/usr/bin/env bash
set -e

BINARY="${HOME}/.local/bin/tiguclaw"
BINARY_ALT="/usr/local/bin/tiguclaw"
DATA_DIR="${HOME}/.tiguclaw"

echo "🐯 tiguclaw uninstaller"
echo ""

# 1. 서비스 중지 + LaunchAgent 제거
PLIST="${HOME}/Library/LaunchAgents/com.tiguclaw.agent.plist"
if [ -f "$PLIST" ]; then
    echo "🗑️  Stopping tiguclaw service..."
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "   ✅ Service removed"
else
    echo "   ℹ️  No service found, skipping"
fi

# 2. 바이너리 제거
if [ -f "$BINARY" ]; then
    rm -f "$BINARY"
    echo "🗑️  Removed $BINARY"
elif [ -f "$BINARY_ALT" ]; then
    rm -f "$BINARY_ALT"
    echo "🗑️  Removed $BINARY_ALT"
else
    echo "   ℹ️  Binary not found, skipping"
fi

# 3. 데이터 디렉토리 — 확인 후 삭제
echo ""
if [ -d "$DATA_DIR" ]; then
    printf "Remove %s? (config, DB, backups) [y/N]: " "$DATA_DIR"
    read -r ans
    case "$ans" in
        [yY]|[yY][eE][sS])
            rm -rf "$DATA_DIR"
            echo "🗑️  Removed $DATA_DIR"
            ;;
        *)
            echo "   ✅ $DATA_DIR preserved (re-install will reuse your config)"
            ;;
    esac
else
    echo "   ℹ️  $DATA_DIR not found, skipping"
fi

echo ""
echo "✅ tiguclaw uninstalled!"
