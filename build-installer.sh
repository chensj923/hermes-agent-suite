#!/bin/bash
# ============================================================
# Hermes Agent Suite — Build Self-Extracting Installer
# Usage: ./build-installer.sh
# Output: hermes-suite-v{VERSION}-linux-x86_64.sh
# ============================================================

VERSION="0.3.0"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STAGING_DIR="/tmp/hermes-pkg-staging"
OUTPUT="${SCRIPT_DIR}/hermes-suite-linux-x86_64.sh"

echo "Building Hermes Agent Suite v${VERSION} installer..."

# ============================================================
# 1. Prepare staging directory
# ============================================================
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

# Copy project files to staging (exclude build artifacts, git, runtime data)
rsync -a \
    --exclude='.git' \
    --exclude='dist' \
    --exclude='node_modules' \
    --exclude='*.pyc' \
    --exclude='__pycache__' \
    --exclude='.env' \
    --exclude='knowledge.db' \
    --exclude='*.log' \
    --exclude='.setup_complete' \
    --exclude='.setup_credentials' \
    --exclude='setup_config.json' \
    --exclude='build-installer.sh' \
    --exclude='hermes-suite-*.sh' \
    "$SCRIPT_DIR/" "$STAGING_DIR/"

echo "[OK] Staging directory prepared"

# ============================================================
# 1.5 Download HermesBuddy clients (not in git due to size)
# ============================================================
BUDDY_DIR="$STAGING_DIR/buddy-dist"
mkdir -p "$BUDDY_DIR"

BUDDY_VERSION="1.4.2"
BUDDY_BASE_URL="https://github.com/chensj923/hermes-agent-suite/releases/download/v0.3.0"

# Check if already present locally
if [ -f "$SCRIPT_DIR/buddy-dist/HermesBuddy-Setup-${BUDDY_VERSION}.exe" ]; then
    info "Copying local HermesBuddy EXE..."
    cp "$SCRIPT_DIR/buddy-dist/HermesBuddy-Setup-${BUDDY_VERSION}.exe" "$BUDDY_DIR/"
else
    info "Downloading HermesBuddy Windows EXE..."
    curl -sL -o "$BUDDY_DIR/HermesBuddy-Setup-${BUDDY_VERSION}.exe" \
        "${BUDDY_BASE_URL}/HermesBuddy-Setup-${BUDDY_VERSION}.exe" 2>/dev/null || \
    warn "Failed to download Windows EXE (will skip)"
fi

if [ -f "$SCRIPT_DIR/buddy-dist/HermesBuddy-${BUDDY_VERSION}.AppImage" ]; then
    info "Copying local HermesBuddy AppImage..."
    cp "$SCRIPT_DIR/buddy-dist/HermesBuddy-${BUDDY_VERSION}.AppImage" "$BUDDY_DIR/"
else
    info "Downloading HermesBuddy Linux AppImage..."
    curl -sL -o "$BUDDY_DIR/HermesBuddy-${BUDDY_VERSION}.AppImage" \
        "${BUDDY_BASE_URL}/HermesBuddy-${BUDDY_VERSION}.AppImage" 2>/dev/null || \
    warn "Failed to download Linux AppImage (will skip)"
fi

# Report what we got
if [ -d "$BUDDY_DIR" ] && [ "$(ls -A "$BUDDY_DIR" 2>/dev/null)" ]; then
    BUDDY_SIZE=$(du -sh "$BUDDY_DIR" | cut -f1)
    info "HermesBuddy clients ready: $BUDDY_SIZE"
else
    warn "No HermesBuddy clients available — download page will show GitHub link instead"
fi

# ============================================================
# 2. Create tarball payload
# ============================================================
PAYLOAD_TAR="/tmp/hermes-payload.tar.gz"
tar czf "$PAYLOAD_TAR" -C "$STAGING_DIR" .
PAYLOAD_SIZE=$(du -sh "$PAYLOAD_TAR" | cut -f1)
echo "[OK] Payload created: $PAYLOAD_SIZE"

# ============================================================
# 3. Write self-extracting installer
# ============================================================
cat > "$OUTPUT" << 'HEADER_EOF'
#!/bin/bash
# ============================================================
# Hermes Agent Suite — Self-Extracting Installer
# This file contains a shell script header + tar.gz payload.
# Run: chmod +x hermes-suite-v*-linux-x86_64.sh && sudo ./hermes-suite-v*-linux-x86_64.sh
# ============================================================

VERSION="__VERSION_PLACEHOLDER__"
INSTALL_DIR="/opt/hermes-suite"
DATA_DIR="$INSTALL_DIR/data"
SERVICE_NAME="hermes-suite-setup"
PORT=9800

# --- Color helpers ---
if [ -t 1 ]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; NC=''
fi

info()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!!]${NC} $1"; }
fail()  { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

echo ""
echo "========================================================"
echo "       Hermes Agent Suite v${VERSION}"
echo "       Self-Extracting Installer"
echo "========================================================"
echo ""

# ============================================================
# 1. Pre-flight checks
# ============================================================
if [ "$(id -u)" -ne 0 ]; then
    fail "This installer requires root privileges. Run: sudo bash $0"
fi

if ! command -v python3 &>/dev/null; then
    fail "python3 not found. Install: apt install python3 / yum install python3"
fi

PYTHON_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
info "Python $PYTHON_VER"

HAS_SYSTEMD=false
if command -v systemctl &>/dev/null && [ -d /run/systemd/system ]; then
    HAS_SYSTEMD=true
    info "systemd available"
else
    warn "systemctl not found. Service will not auto-start."
fi

# Check port
if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
    warn "Port $PORT is already in use!"
    ss -tlnp 2>/dev/null | grep ":${PORT} "
    read -p "Kill existing process and continue? [y/N] " yn
    if [ "$yn" = "y" ] || [ "$yn" = "Y" ]; then
        PIDS=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K\d+')
        for pid in $PIDS; do kill $pid 2>/dev/null; done
        sleep 1
        info "Port $PORT freed"
    else
        echo "Cancelled."
        exit 0
    fi
fi

# ============================================================
# 2. Handle existing installation
# ============================================================
if [ -d "$INSTALL_DIR" ]; then
    warn "Existing installation detected at $INSTALL_DIR"
    FILE_COUNT=$(find "$INSTALL_DIR" -type f 2>/dev/null | wc -l)
    DIR_SIZE=$(du -sh "$INSTALL_DIR" 2>/dev/null | cut -f1)
    echo "Files: $FILE_COUNT"
    echo "Size: $DIR_SIZE"

    if [ "$HAS_SYSTEMD" = true ]; then
        SVC_STATUS=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo "inactive")
        echo "Service: $SVC_STATUS"
    fi

    if [ -f "$DATA_DIR/.setup_complete" ]; then
        echo "Setup: COMPLETED"
    else
        echo "Setup: NOT COMPLETED"
    fi

    echo ""
    echo "Options:"
    echo "  1) Clean install (remove everything, reinstall)"
    echo "  2) Upgrade (keep data/credentials, replace code)"
    echo "  3) Cancel"
    read -p "Choose [1/2/3]: " choice

    case "$choice" in
        1)
            info "Cleaning previous installation..."
            systemctl stop "$SERVICE_NAME" 2>/dev/null
            systemctl disable "$SERVICE_NAME" 2>/dev/null
            rm -rf "$INSTALL_DIR"
            rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
            rm -rf /root/.hermes
            systemctl daemon-reload 2>/dev/null
            info "Cleanup complete"
            ;;
        2)
            info "Upgrade mode: keeping data and credentials"
            ;;
        *)
            echo "Cancelled."
            exit 0
            ;;
    esac
fi

# ============================================================
# 3. Extract payload
# ============================================================
info "Extracting files..."
mkdir -p "$INSTALL_DIR" "$DATA_DIR"

# Find archive start line
ARCHIVE_LINE=$(awk '/^__ARCHIVE_START__$/{print NR + 1; exit 0; }' "$0")

if [ -z "$ARCHIVE_LINE" ]; then
    fail "Archive marker not found in this script. File may be corrupted."
fi

if ! tail -n +"$ARCHIVE_LINE" "$0" | tar xzf - -C "$INSTALL_DIR" 2>/tmp/hermes-install-err.log; then
    fail "Extraction failed: $(cat /tmp/hermes-install-err.log)"
fi

# Verify critical files
MISSING=""
for f in scripts/setup-server.py web-setup/index.html install.sh; do
    if [ ! -f "$INSTALL_DIR/$f" ]; then
        MISSING="$MISSING $f"
    fi
done
if [ -n "$MISSING" ]; then
    fail "Missing critical files after extraction:$MISSING"
fi

info "Files extracted to $INSTALL_DIR"

# ============================================================
# 4. Install Python dependencies
# ============================================================
info "Installing Python dependencies..."
pip3 install -q --break-system-packages flask pyyaml requests 2>/dev/null || \
pip3 install -q flask pyyaml requests 2>/dev/null || \
warn "Some pip packages may need manual install"

# ============================================================
# 5. Register and start setup service
# ============================================================
if [ "$HAS_SYSTEMD" = true ]; then
    cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=Hermes Agent Suite Setup Wizard
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/python3 ${INSTALL_DIR}/scripts/setup-server.py
Environment=PYTHONUNBUFFERED=1
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME" 2>/dev/null
    systemctl start "$SERVICE_NAME"

    sleep 1
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        info "Setup service started"
    else
        warn "Service failed to start, trying nohup..."
        nohup python3 "$INSTALL_DIR/scripts/setup-server.py" > "$DATA_DIR/setup.log" 2>&1 &
        info "Setup service started (nohup)"
    fi
else
    nohup python3 "$INSTALL_DIR/scripts/setup-server.py" > "$DATA_DIR/setup.log" 2>&1 &
    info "Setup service started (nohup, no systemd)"
fi

# ============================================================
# 6. Done — show credentials
# ============================================================
# Wait for service to generate credentials
sleep 2

# Read credentials from file or log
CRED_FILE="$DATA_DIR/.setup_credentials"
ADMIN_USER=""
ADMIN_PASS=""

if [ -f "$CRED_FILE" ]; then
    ADMIN_USER=$(python3 -c "import json; c=json.load(open('$CRED_FILE')); print(c.get('username',''))" 2>/dev/null)
    ADMIN_PASS=$(python3 -c "import json; c=json.load(open('$CRED_FILE')); print(c.get('password',''))" 2>/dev/null)
fi

# Fallback: parse from service log
if [ -z "$ADMIN_PASS" ] && [ -f "$DATA_DIR/setup.log" ]; then
    ADMIN_USER=$(grep -oP 'Username:\s+\K\S+' "$DATA_DIR/setup.log" 2>/dev/null | head -1)
    ADMIN_PASS=$(grep -oP 'Password:\s+\K\S+' "$DATA_DIR/setup.log" 2>/dev/null | head -1)
fi

echo ""
echo "========================================================"
echo "  Installation Complete!"
echo "========================================================"
echo ""
echo "  Open your browser and visit:"
echo "    http://localhost:${PORT}"
echo ""
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$LOCAL_IP" ]; then
    echo "  Or from another machine:"
    echo "    http://${LOCAL_IP}:${PORT}"
    echo ""
fi
if [ -n "$ADMIN_USER" ] && [ -n "$ADMIN_PASS" ]; then
    echo "  🔑 Login Credentials:"
    echo "     Username: $ADMIN_USER"
    echo "     Password: $ADMIN_PASS"
    echo ""
fi
echo "  Follow the web wizard to complete configuration."
echo "========================================================"

exit 0
__ARCHIVE_START__
HEADER_EOF

# Replace version placeholder
sed -i "s/__VERSION_PLACEHOLDER__/${VERSION}/g" "$OUTPUT"

# Append tarball payload
cat "$PAYLOAD_TAR" >> "$OUTPUT"

chmod +x "$OUTPUT"

FINAL_SIZE=$(du -sh "$OUTPUT" | cut -f1)
echo ""
echo "========================================================"
echo "  Build Complete!"
echo "  Output: $OUTPUT"
echo "  Size: $FINAL_SIZE"
echo "========================================================"

# Cleanup
rm -rf "$STAGING_DIR" "$PAYLOAD_TAR"
