#!/bin/bash
# ============================================================
# Hermes Agent Suite — Build Installer from Source
# Usage: cd hermes-agent-suite && chmod +x install.sh && ./install.sh
# Output: hermes-suite-linux-x86_64.sh (self-extracting installer)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "========================================================"
echo "       Hermes Agent Suite"
echo "       Build Installer from Source"
echo "========================================================"
echo ""

# Check build-installer.sh exists
if [ ! -f "$SCRIPT_DIR/build-installer.sh" ]; then
    echo "[ERR] build-installer.sh not found in $SCRIPT_DIR"
    echo "Make sure you are running this from the hermes-agent-suite directory."
    exit 1
fi

# Run build script
echo "Building self-extracting installer..."
echo ""
bash "$SCRIPT_DIR/build-installer.sh"
BUILD_EXIT=$?

if [ $BUILD_EXIT -ne 0 ]; then
    echo ""
    echo "[ERR] Build failed!"
    exit 1
fi

echo ""
echo "========================================================"
echo "  Build Complete!"
echo "========================================================"
echo ""
echo "  To install, run:"
echo "    sudo ./hermes-suite-linux-x86_64.sh"
echo ""
echo "========================================================"
