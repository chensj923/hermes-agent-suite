#!/bin/bash
# ============================================================
# Hermes Agent Suite — Self-Extracting Installer
# Usage: bash hermes-suite-v1.0.0-linux-x86_64.sh
# ============================================================

VERSION="1.1.0"
INSTALL_DIR="/opt/hermes-suite"
DATA_DIR="$INSTALL_DIR/data"
SERVICE_NAME="hermes-suite-setup"
PORT=9800

# --- Color helpers (safe for non-tty) ---
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

# Root check
if [ "$(id -u)" -ne 0 ]; then
    fail "This installer requires root privileges. Run: sudo bash $0"
fi

# Python3 check
if ! command -v python3 &>/dev/null; then
    fail "python3 not found. Install: apt install python3 / yum install python3"
fi

PYTHON_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PYTHON_MAJOR=$(echo "$PYTHON_VER" | cut -d. -f1)
PYTHON_MINOR=$(echo "$PYTHON_VER" | cut -d. -f2)
if [ "$PYTHON_MAJOR" -lt 3 ] || ([ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -lt 8 ]); then
    fail "Python >= 3.8 required, found $PYTHON_VER"
fi
info "Python $PYTHON_VER"

# systemd check
if ! command -v systemctl &>/dev/null; then
    warn "systemctl not found. Service will not auto-start."
    warn "You can run manually: python3 $INSTALL_DIR/scripts/setup-server.py"
    NO_SYSTEMD=1
else
    info "systemd available"
fi

# Port check
if ss -tlnp 2>/dev/null | grep -q ":${PORT} " || netstat -tlnp 2>/dev/null | grep -q ":${PORT} "; then
    warn "Port $PORT is already in use!"
    PROC=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | head -1 || true)
    echo "     $PROC"
    echo ""
    read -r -p "     Kill existing process and continue? [y/N] " ANSWER
    if [[ "$ANSWER" =~ ^[Yy]$ ]]; then
        fuser -k ${PORT}/tcp 2>/dev/null || true
        sleep 1
        info "Port $PORT freed"
    else
        fail "Port $PORT occupied. Aborting."
    fi
fi

# ============================================================
# 2. Existing installation detection
# ============================================================

EXISTING=0
if [ -d "$INSTALL_DIR" ]; then
    EXISTING=1
    echo ""
    warn "Existing installation detected at $INSTALL_DIR"
    echo ""
    
    # Show what's there
    FILE_COUNT=$(find "$INSTALL_DIR" -type f 2>/dev/null | wc -l)
    DIR_SIZE=$(du -sh "$INSTALL_DIR" 2>/dev/null | cut -f1)
    echo "     Files: $FILE_COUNT"
    echo "     Size:  $DIR_SIZE"
    
    # Check service status
    if [ -z "$NO_SYSTEMD" ]; then
        SVC_STATUS=$(systemctl is-active ${SERVICE_NAME} 2>/dev/null || echo "inactive")
        echo "     Service: $SVC_STATUS"
    fi
    
    # Check if setup was completed
    if [ -f "$DATA_DIR/.setup_complete" ]; then
        echo "     Setup: COMPLETED"
    elif [ -f "$DATA_DIR/.setup_credentials" ]; then
        echo "     Setup: IN PROGRESS (credentials generated)"
    else
        echo "     Setup: NOT STARTED"
    fi
    
    echo ""
    echo "     Options:"
    echo "       1) Clean install (remove everything, reinstall)"
    echo "       2) Upgrade (keep data/credentials, replace code)"
    echo "       3) Cancel"
    echo ""
    read -r -p "     Choose [1/2/3]: " CHOICE
    
    case "$CHOICE" in
        1)
            echo ""
            info "Cleaning previous installation..."
            
            # Stop service first
            if [ -z "$NO_SYSTEMD" ]; then
                systemctl stop ${SERVICE_NAME} 2>/dev/null || true
                systemctl disable ${SERVICE_NAME} 2>/dev/null || true
            fi
            
            # Kill anything on our port
            fuser -k ${PORT}/tcp 2>/dev/null || true
            sleep 1
            
            # Remove install dir
            rm -rf "$INSTALL_DIR"
            info "Removed $INSTALL_DIR"
            
            # Remove ~/.hermes (generated configs, env, etc.)
            if [ -d "/root/.hermes" ]; then
                rm -rf "/root/.hermes"
                info "Removed /root/.hermes"
            fi
            
            # Kill related processes
            pkill -9 -f crystal_reflex 2>/dev/null || true
            pkill -9 -f ocr_server 2>/dev/null || true
            pkill -9 -f "node.*server.js" 2>/dev/null || true
            pkill -9 -f hermes_cli 2>/dev/null || true
            
            # Remove service file
            rm -f /etc/systemd/system/${SERVICE_NAME}.service
            if [ -z "$NO_SYSTEMD" ]; then
                systemctl daemon-reload 2>/dev/null || true
            fi
            info "Removed systemd service"
            
            # Remove stale symlinks
            find /etc/systemd/system/ -lname "*${SERVICE_NAME}*" -delete 2>/dev/null || true
            
            info "Cleanup complete"
            ;;
        2)
            echo ""
            info "Upgrade mode: preserving $DATA_DIR"
            UPGRADE=1
            ;;
        3|*)
            echo ""
            echo "     Installation cancelled."
            exit 0
            ;;
    esac
    echo ""
fi

# ============================================================
# 3. Extract payload
# ============================================================

echo "Extracting files..."

# Find archive start line
ARCHIVE_LINE=$(awk '/^__ARCHIVE_START__$/{print NR + 1; exit 0; }' "$0")
if [ -z "$ARCHIVE_LINE" ]; then
    fail "Corrupted installer: archive marker not found"
fi

# Create dirs
mkdir -p "$INSTALL_DIR"

# Extract with error handling
if ! tail -n +"$ARCHIVE_LINE" "$0" | tar xzf - -C "$INSTALL_DIR" 2>/tmp/hermes-install-err.log; then
    ERR=$(cat /tmp/hermes-install-err.log 2>/dev/null)
    fail "Extraction failed: $ERR"
fi
rm -f /tmp/hermes-install-err.log

# Verify critical files
MISSING=""
for f in scripts/setup-server.py web-setup/index.html .hermes/.env.example; do
    if [ ! -f "$INSTALL_DIR/$f" ]; then
        MISSING="$MISSING $f"
    fi
done
if [ -n "$MISSING" ]; then
    fail "Missing critical files after extraction:$MISSING"
fi

info "Files extracted to $INSTALL_DIR"

# Create data directory (preserve if upgrade)
mkdir -p "$DATA_DIR"

# ============================================================
# 4. Install systemd service
# ============================================================

if [ -z "$NO_SYSTEMD" ]; then
    echo "Installing systemd service..."
    
    cat > /etc/systemd/system/${SERVICE_NAME}.service << SVCEOF
[Unit]
Description=Hermes Agent Suite Setup Wizard
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 ${INSTALL_DIR}/scripts/setup-server.py
Environment=HERMES_INSTALL_DIR=${INSTALL_DIR}
Environment=HERMES_SETUP_PORT=${PORT}
Restart=on-failure
RestartSec=5
WorkingDirectory=${INSTALL_DIR}

[Install]
WantedBy=multi-user.target
SVCEOF

    systemctl daemon-reload
    systemctl enable ${SERVICE_NAME} 2>/dev/null
    systemctl start ${SERVICE_NAME}
    
    # Verify service started
    sleep 2
    SVC_STATUS=$(systemctl is-active ${SERVICE_NAME} 2>/dev/null || echo "unknown")
    if [ "$SVC_STATUS" = "active" ]; then
        info "Service started successfully"
    else
        warn "Service status: $SVC_STATUS"
        warn "Check logs: journalctl -u ${SERVICE_NAME} -n 20"
        
        # Fallback: try running directly
        echo "     Attempting direct start..."
        HERMES_INSTALL_DIR="$INSTALL_DIR" HERMES_SETUP_PORT="$PORT" \
            nohup python3 "$INSTALL_DIR/scripts/setup-server.py" > /tmp/hermes-setup.log 2>&1 &
        sleep 2
        if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
            info "Direct start succeeded (no systemd management)"
        else
            fail "Setup server failed to start. Check /tmp/hermes-setup.log"
        fi
    fi
else
    # No systemd — run directly
    echo "Starting setup server directly..."
    HERMES_INSTALL_DIR="$INSTALL_DIR" HERMES_SETUP_PORT="$PORT" \
        nohup python3 "$INSTALL_DIR/scripts/setup-server.py" > /tmp/hermes-setup.log 2>&1 &
    sleep 2
    if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
        info "Setup server started (PID: $(pgrep -f setup-server.py))"
    else
        fail "Setup server failed to start. Check /tmp/hermes-setup.log"
    fi
fi

# ============================================================
# 5. Wait for ready & get credentials
# ============================================================

echo "Waiting for setup wizard..."
RETRIES=0
MAX_RETRIES=10
while [ $RETRIES -lt $MAX_RETRIES ]; do
    if curl -sf http://localhost:${PORT}/api/status > /dev/null 2>&1; then
        break
    fi
    RETRIES=$((RETRIES + 1))
    sleep 1
done

if [ $RETRIES -ge $MAX_RETRIES ]; then
    warn "Setup wizard not responding after ${MAX_RETRIES}s"
    warn "Try manually: curl http://localhost:${PORT}/api/status"
fi

# Get credentials
USERNAME="admin"
PASSWORD="(see server output)"
if [ -f "$DATA_DIR/.setup_credentials" ]; then
    USERNAME=$(python3 -c "import json; c=json.load(open('$DATA_DIR/.setup_credentials')); print(c.get('username','admin'))" 2>/dev/null || echo "admin")
    PASSWORD=$(python3 -c "import json; c=json.load(open('$DATA_DIR/.setup_credentials')); print(c.get('password','???'))" 2>/dev/null || echo "???")
fi

# Detect local IP
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LOCAL_IP" ] && LOCAL_IP="localhost"

# ============================================================
# 6. Done
# ============================================================

echo ""
echo "========================================================"
echo "          Installation Complete!"
echo "========================================================"
echo ""
echo "  Open in browser:"
echo "     http://localhost:${PORT}"
echo "     http://${LOCAL_IP}:${PORT}"
echo ""
echo "  Login Credentials:"
echo "     Username: ${USERNAME}"
echo "     Password: ${PASSWORD}"
echo ""
if [ -z "$NO_SYSTEMD" ]; then
    echo "  Management Commands:"
    echo "     systemctl status  ${SERVICE_NAME}"
    echo "     systemctl stop    ${SERVICE_NAME}"
    echo "     systemctl restart ${SERVICE_NAME}"
    echo ""
fi
echo "  Uninstall:"
echo "     bash $0   (choose option 1 to clean)"
echo ""
echo "  Install Directory: ${INSTALL_DIR}"
echo "  Data Directory:    ${DATA_DIR}"
echo ""
echo "========================================================"
echo ""

exit 0
__ARCHIVE_START__
