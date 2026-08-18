#!/bin/bash
# Detect cameras, microphones, speakers, and GPU
# Robust detection with fallbacks - works on minimal Linux systems
# Output: JSON to stdout

# Use python3 if available, otherwise fall back to manual JSON construction
if command -v python3 &>/dev/null; then
    python3 << 'PYEOF'
import subprocess, json, os, glob, re, sys

result = {'cameras': [], 'microphones': [], 'speakers': [], 'gpu': []}

# --- Cameras ---
# Method 1: /dev/video* (always check, even without v4l2-ctl)
for dev in sorted(glob.glob('/dev/video*')):
    name = 'Video Device'
    # Try v4l2-ctl for friendly name
    try:
        r = subprocess.run(['v4l2-ctl', '-d', dev, '--info'],
                          capture_output=True, timeout=5)
        for line in r.stdout.decode(errors='replace').splitlines():
            if 'Driver name' in line or 'Card type' in line:
                name = line.split(':')[-1].strip()
                if 'Card type' in line:
                    break  # Card type is more descriptive
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    # Try sysfs for name
    if name == 'Video Device':
        basename = os.path.basename(dev)
        sysfs = f'/sys/class/video4linux/{basename}/name'
        if os.path.exists(sysfs):
            try:
                name = open(sysfs).read().strip()
            except:
                pass
    result['cameras'].append({'path': dev, 'name': name})

# --- Microphones ---
# Method 1: arecord -l (ALSA)
try:
    r = subprocess.run(['arecord', '-l'], capture_output=True, timeout=5)
    for line in r.stdout.decode(errors='replace').splitlines():
        if line.startswith('card'):
            m = re.search(r'card (\d+).*device (\d+)', line)
            nm = re.findall(r'\[(.*?)\]', line)
            if m:
                card, dev = m.group(1), m.group(2)
                # card 0: Audio [SA9023 USB Audio], device 0: USB Audio
                # nm[0] = card alias, nm[1] = full name (if present)
                name = nm[1] if len(nm) > 1 else (nm[0] if nm else 'Audio Device')
                result['microphones'].append({'path': f'hw:{card},{dev}', 'name': name})
except (FileNotFoundError, subprocess.TimeoutExpired):
    pass

# Method 2: /proc/asound (fallback if arecord missing)
if not result['microphones'] and os.path.exists('/proc/asound/cards'):
    try:
        cards = open('/proc/asound/cards').read()
        for line in cards.splitlines():
            # 0 [Audio          ]: USB-Audio - SA9023 USB Audio
            m = re.match(r'\s*(\d+)\s+\[(\w+)\s*\]:\s+(\S+)\s*-\s*(.*)', line)
            if m:
                card_id = m.group(1)
                name = m.group(4).strip()
                result['microphones'].append({'path': f'hw:{card_id},0', 'name': name})
    except:
        pass

# --- Speakers ---
# Method 1: aplay -l (ALSA)
try:
    r = subprocess.run(['aplay', '-l'], capture_output=True, timeout=5)
    for line in r.stdout.decode(errors='replace').splitlines():
        if line.startswith('card'):
            m = re.search(r'card (\d+).*device (\d+)', line)
            nm = re.findall(r'\[(.*?)\]', line)
            if m:
                card, dev = m.group(1), m.group(2)
                name = nm[1] if len(nm) > 1 else (nm[0] if nm else 'Audio Device')
                result['speakers'].append({'path': f'hw:{card},{dev}', 'name': name})
except (FileNotFoundError, subprocess.TimeoutExpired):
    pass

# Method 2: /proc/asound (fallback)
if not result['speakers'] and os.path.exists('/proc/asound/cards'):
    try:
        cards = open('/proc/asound/cards').read()
        for line in cards.splitlines():
            m = re.match(r'\s*(\d+)\s+\[(\w+)\s*\]:\s+(\S+)\s*-\s*(.*)', line)
            if m:
                card_id = m.group(1)
                name = m.group(4).strip()
                result['speakers'].append({'path': f'hw:{card_id},0', 'name': name})
    except:
        pass

# --- GPU ---
# Method 1: nvidia-smi
try:
    r = subprocess.run(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
                      capture_output=True, timeout=5)
    if r.returncode == 0 and r.stdout.strip():
        for line in r.stdout.decode().strip().splitlines():
            result['gpu'].append({'name': line.strip(), 'type': 'nvidia'})
except (FileNotFoundError, subprocess.TimeoutExpired):
    pass

# Method 2: lspci (AMD/Intel integrated)
if not result['gpu']:
    try:
        r = subprocess.run(['lspci'], capture_output=True, timeout=5)
        for line in r.stdout.decode(errors='replace').splitlines():
            if any(k in line.lower() for k in ['vga compatible', '3d controller', 'display controller']):
                name = line.split(':')[-1].strip()
                gpu_type = 'nvidia' if 'nvidia' in name.lower() else ('amd' if 'amd' in name.lower() or 'radeon' in name.lower() else 'integrated')
                result['gpu'].append({'name': name, 'type': gpu_type})
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

# Method 3: /proc/driver/nvidia (last resort)
if not result['gpu'] and os.path.exists('/proc/driver/nvidia'):
    result['gpu'].append({'name': 'NVIDIA GPU', 'type': 'nvidia'})

print(json.dumps(result))
PYEOF
    exit 0
fi

# --- Fallback: no python3, manual JSON ---
echo '{"cameras":['
first=1
for dev in /dev/video*; do
    [ -e "$dev" ] || continue
    [ $first -eq 1 ] || echo -n ','
    echo -n "{\"path\":\"$dev\",\"name\":\"Video Device\"}"
    first=0
done
echo -n '],"microphones":['
# /proc/asound fallback
first=1
if [ -f /proc/asound/cards ]; then
    while IFS= read -r line; do
        card=$(echo "$line" | awk '{print $1}')
        [ -z "$card" ] && continue
        name=$(echo "$line" | sed 's/.*- //')
        [ $first -eq 1 ] || echo -n ','
        echo -n "{\"path\":\"hw:$card,0\",\"name\":\"$name\"}"
        first=0
    done < /proc/asound/cards
fi
echo -n '],"speakers":['
first=1
if [ -f /proc/asound/cards ]; then
    while IFS= read -r line; do
        card=$(echo "$line" | awk '{print $1}')
        [ -z "$card" ] && continue
        name=$(echo "$line" | sed 's/.*- //')
        [ $first -eq 1 ] || echo -n ','
        echo -n "{\"path\":\"hw:$card,0\",\"name\":\"$name\"}"
        first=0
    done < /proc/asound/cards
fi
echo -n '],"gpu":[]}'
