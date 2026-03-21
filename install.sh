#!/bin/bash
# tiguclaw install script — builds and installs the binary to /usr/local/bin

set -e

BINARY_NAME="tiguclaw"
INSTALL_DIR="/usr/local/bin"
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
if [ -w "$INSTALL_DIR" ]; then
    cp "$BINARY" "$INSTALL_DIR/$BINARY_NAME"
else
    sudo cp "$BINARY" "$INSTALL_DIR/$BINARY_NAME"
fi

echo "✅ Installed successfully!"
echo ""
echo "Next steps:"
echo "  1. cp config.toml.example config.toml"
echo "  2. Edit config.toml with your tokens"
echo "  3. tiguclaw"
