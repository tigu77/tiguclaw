#!/bin/bash
# tiguclaw install script — builds and installs the binary to /usr/local/bin

set -e

BINARY_NAME="tiguclaw"
# Prefer ~/.local/bin (no sudo needed); fallback to /usr/local/bin
if [ -d "$HOME/.local/bin" ] || mkdir -p "$HOME/.local/bin" 2>/dev/null; then
    INSTALL_DIR="$HOME/.local/bin"
else
    INSTALL_DIR="/usr/local/bin"
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🔨 Building tiguclaw (release)..."
cd "$SCRIPT_DIR"
cargo build --release

BINARY="$SCRIPT_DIR/target/release/$BINARY_NAME"

if [ ! -f "$BINARY" ]; then
    echo "❌ Build failed: $BINARY not found"
    exit 1
fi

echo "📦 Installing to $INSTALL_DIR/$BINARY_NAME..."
cp "$BINARY" "$INSTALL_DIR/$BINARY_NAME"

# Remind user to add to PATH if needed
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ""
    echo "💡 Add to PATH (add to ~/.zshrc or ~/.bashrc):"
    echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo "✅ Installed successfully!"
echo ""
echo "Next steps:"
echo "  1. cp config.toml.example config.toml"
echo "  2. Edit config.toml with your tokens"
echo "  3. tiguclaw"
