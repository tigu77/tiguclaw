#!/bin/bash
set -e

REPO="tigu77/tiguclaw"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

# 최신 릴리즈 바이너리 다운로드
echo "⬇️  Downloading tiguclaw..."
curl -fsSL "https://github.com/$REPO/releases/latest/download/tiguclaw" \
  -o "$BIN_DIR/tiguclaw"
chmod +x "$BIN_DIR/tiguclaw"

# PATH 안내
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  echo ""
  echo "Add to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo "✅ tiguclaw installed to $BIN_DIR/tiguclaw"
echo ""
echo "Next: tiguclaw init"
