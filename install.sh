#!/bin/bash
# ============================================================
# Hermes Agent Suite — Install from Source
# Usage: cd hermes-agent-suite && chmod +x install.sh && ./install.sh
# ============================================================

VERSION="0.3.0"
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
echo "       Install from Source"
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

# Check systemd
HAS_SYSTEMD=false
if command -v systemctl &>/dev/null && [ -d /run/systemd/system ]; then
    HAS_SYSTEMD=true
    info "systemd available"
else
    warn "systemctl not found. Service will not auto-start."
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
    
    # Check service status
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
# 3. Copy source files to install directory
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
info "Installing from $SCRIPT_DIR"

mkdir -p "$INSTALL_DIR" "$DATA_DIR"

# Copy project files (exclude .git, dist, node_modules, etc.)
info "Copying files to $INSTALL_DIR ..."
rsync -a --exclude='.git' \
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
         "$SCRIPT_DIR/" "$INSTALL_DIR/"

# Verify critical files
MISSING=""
for f in scripts/setup-server.py web-setup/index.html build-installer.sh; do
    if [ ! -f "$INSTALL_DIR/$f" ]; then
        MISSING="$MISSING $f"
    fi
done
if [ -n "$MISSING" ]; then
    fail "Missing critical files after copy:$MISSING"
fi

info "Files installed to $INSTALL_DIR"

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
# 6. Done
# ============================================================
echo ""
echo "========================================================"
echo "  Installation Complete!"
echo "========================================================"
echo ""
echo "  Open your browser and visit:"
echo "    http://localhost:${PORT}"
echo ""
echo "  Or from another machine:"
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$LOCAL_IP" ]; then
    echo "    http://${LOCAL_IP}:${PORT}"
fi
echo ""
echo "  Follow the web wizard to complete configuration."
echo "========================================================"
