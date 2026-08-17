#!/usr/bin/env python3
"""
sanitize.py — Hermes Agent Suite 去敏脚本
用法: python3 sanitize.py --source /root --dest /tmp/hermes-suite-clean

扫描三套系统，替换所有敏感信息为占位符，输出干净的副本。
"""

import os, re, shutil, json, sqlite3, argparse
from pathlib import Path

# ============================================================
# 敏感模式定义
# ============================================================
PATTERNS = [
    # API Keys (sk-*, 火山 UUID, router key)
    (r'sk-[a-zA-Z0-9_-]{20,}', 'YOUR_API_KEY'),
    (r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'YOUR_UUID_KEY'),
    # Passwords in sshpass / SUDO_PASSWORD
    (r"sshpass\s+-p\s+'[^']*'", "sshpass -p 'YOUR_PASSWORD'"),
    (r"sshpass\s+-p\s+\S+", "sshpass -p YOUR_PASSWORD"),
    (r'SUDO_PASSWORD\s*=\s*\S+', 'SUDO_PASSWORD=YOUR_SUDO_PASSWORD'),
    # Known passwords (specific values found in scan)
    (r'Hjp\d+', 'YOUR_PASSWORD'),
    (r'P@ssw0rd\d+', 'YOUR_PASSWORD'),
    # AppSecret
    (r'(FEISHU_APP_SECRET\s*[:=]\s*)\S+', r'\1YOUR_FEISHU_APP_SECRET'),
    (r'(APP_SECRET\s*[:=]\s*)\S+', r'\1YOUR_APP_SECRET'),
    (r'zpCs[a-zA-Z0-9]+', 'YOUR_FEISHU_APP_SECRET'),
    # Gateway tokens
    (r'(HERMES_GATEWAY_TOKEN\s*[:=]\s*)\S+', r'\1YOUR_GATEWAY_TOKEN'),
    (r'(API_SERVER_KEY\s*[:=]\s*)\S+', r'\1YOUR_API_SERVER_KEY'),
    # Bearer tokens
    (r'Bearer\s+[a-zA-Z0-9._-]{20,}', 'Bearer YOUR_TOKEN'),
    # Private IPs with context (keep localhost)
    (r'192\.168\.\d+\.\d+', '<YOUR_LOCAL_IP>'),
    (r'43\.153\.\d+\.\d+', '<YOUR_SERVER_IP>'),
    # Chat IDs / open_ids (Feishu)
    (r'ou_[0-9a-f]{32}', '<USER_OPEN_ID>'),
    (r'oc_[0-9a-f]{32}', '<CHAT_ID>'),
    # Volcano key fragments in docs
    (r'1faf[a-f0-9-]+', 'YOUR_VOLCANO_KEY'),
    # WeChat Official Account credentials (replace with your own)
    (r'wx[a-f0-9]{16}', '<WECHAT_APP_ID>'),
    (r'[a-f0-9]{32}', '<WECHAT_APP_SECRET>'),
]

# Files to skip entirely
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', 'dist', '.cache', 'venv', 'cache', 'sessions'}
SKIP_FILES = {'state.db', 'sessions.db', 'response_store.db', 'auth.json', 'executions.db'}

def sanitize_text(text):
    """Apply all patterns to text content."""
    for pattern, replacement in PATTERNS:
        text = re.sub(pattern, replacement, text)
    return text

def sanitize_file(src, dst):
    """Copy and sanitize a single file."""
    try:
        with open(src, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
        
        # For code files, only apply safe patterns (skip env var value replacements
        # that could break string literals in code)
        ext = os.path.splitext(src)[1].lower()
        code_exts = {'.js', '.ts', '.py', '.sh', '.bash', '.go', '.rs', '.html', '.htm', '.css'}
        if ext in code_exts:
            sanitized = sanitize_text_code_safe(content)
        else:
            sanitized = sanitize_text(content)
        
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'w', encoding='utf-8') as f:
            f.write(sanitized)
        return True
    except Exception as e:
        print(f"  ⚠️  Skip {src}: {e}")
        return False


# Patterns safe for code files (won't break string literals / logic)
CODE_SAFE_PATTERNS = [
    # Only replace actual secret values, not variable names in code
    (r'sk-[a-zA-Z0-9_-]{20,}', 'YOUR_API_KEY'),
    (r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'YOUR_UUID_KEY'),
    (r"sshpass\s+-p\s+'[^']*'", "sshpass -p 'YOUR_PASSWORD'"),
    (r'Hjp\d+', 'YOUR_PASSWORD'),
    (r'P@ssw0rd\d+', 'YOUR_PASSWORD'),
    (r'zpCs[a-zA-Z0-9]+', 'YOUR_FEISHU_APP_SECRET'),
    (r'Bearer\s+[a-zA-Z0-9._-]{20,}', 'Bearer YOUR_TOKEN'),
    (r'192\.168\.\d+\.\d+', '<YOUR_LOCAL_IP>'),
    (r'43\.153\.\d+\.\d+', '<YOUR_SERVER_IP>'),
    (r'ou_[0-9a-f]{32}', '<USER_OPEN_ID>'),
    (r'oc_[0-9a-f]{32}', '<CHAT_ID>'),
    (r'1faf[a-f0-9-]+', 'YOUR_VOLCANO_KEY'),
    (r'wx[a-f0-9]{16}', '<WECHAT_APP_ID>'),
]

def sanitize_text_code_safe(text):
    """Apply only code-safe patterns (no env var value replacements)."""
    for pattern, replacement in CODE_SAFE_PATTERNS:
        text = re.sub(pattern, replacement, text)
    return text

def sanitize_db(src, dst):
    """Sanitize SQLite database - copy schema, clean data."""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    try:
        conn = sqlite3.connect(dst)
        cur = conn.cursor()
        # Get all tables
        tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        cleaned = 0
        for table in tables:
            cols = [r[1] for r in cur.execute(f"PRAGMA table_info({table})").fetchall()]
            text_cols = [c for c in cols if c in ('content', 'input_text', 'output_text', 'text', 'message', 'data', 'reasoning_content', 'api_content')]
            for col in text_cols:
                for pattern, replacement in PATTERNS:
                    cur.execute(f"UPDATE {table} SET {col} = ? WHERE {col} LIKE ?",
                              (None, f'%{replacement.split()[0] if " " in replacement else replacement}%'))
                # Direct regex replacement via Python (SQLite lacks REGEXP_REPLACE)
                rows = cur.execute(f"SELECT rowid, {col} FROM {table} WHERE {col} IS NOT NULL").fetchall()
                for rowid, val in rows:
                    new_val = sanitize_text(val)
                    if new_val != val:
                        cur.execute(f"UPDATE {table} SET {col} = ? WHERE rowid = ?", (new_val, rowid))
                        cleaned += 1
        conn.commit()
        conn.close()
        print(f"  🧹 DB cleaned: {cleaned} fields sanitized in {dst}")
    except Exception as e:
        print(f"  ⚠️  DB sanitize failed {dst}: {e}")

def should_skip(path):
    parts = Path(path).parts
    return any(p in SKIP_DIRS for p in parts) or os.path.basename(path) in SKIP_FILES

def main():
    parser = argparse.ArgumentParser(description='Sanitize Hermes Suite for open-source release')
    parser.add_argument('--source', default='/root', help='Source root directory')
    parser.add_argument('--dest', default='/tmp/hermes-suite-clean', help='Destination directory')
    args = parser.parse_args()

    src_root = Path(args.source)
    dst_root = Path(args.dest)

    # Directories to process
    targets = [
        ('.hermes', ['config.yaml', '.env', 'profiles/', 'plugins/', 'skills/']),
        ('workbuddy', ['server.js', 'desktop/', 'connectors.json']),
        ('crystallization', ['*.py', '*.yaml', '*.sh', 'crystallization.db']),
    ]

    total_files = 0
    total_sanitized = 0

    for base_dir, patterns in targets:
        src_base = src_root / base_dir
        dst_base = dst_root / base_dir
        if not src_base.exists():
            print(f"⏭️  Skip {base_dir} (not found)")
            continue

        print(f"\n📁 Processing {base_dir}/")
        for root, dirs, files in os.walk(src_base):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for fname in files:
                src_path = Path(root) / fname
                rel = src_path.relative_to(src_root)
                dst_path = dst_root / rel

                if should_skip(str(src_path)):
                    continue

                if fname.endswith('.db') or fname.endswith('.sqlite'):
                    sanitize_db(str(src_path), str(dst_path))
                elif fname.endswith(('.bak', '.old', '.backup')):
                    print(f"  🗑️  Skip backup: {rel}")
                    continue
                else:
                    if sanitize_file(str(src_path), str(dst_path)):
                        total_files += 1

    # Generate .env.example
    env_example = dst_root / '.hermes' / '.env.example'
    os.makedirs(env_example.parent, exist_ok=True)
    with open(env_example, 'w') as f:
        f.write("""# Hermes Agent Suite — Environment Variables
# Copy this file to .env and fill in your values.

# === Model Providers ===
OPENAI_API_KEY=sk-your-openai-key
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key
QWEN_API_KEY=sk-your-qwen-key
CODING_API_KEY=sk-your-coding-key
VOLCANO_ACCESS_TOKEN=your-volcano-uuid-key
LM_API_KEY=sk-your-lmstudio-key
LM_BASE_URL=http://localhost:1234/v1

# === Gateway ===
HERMES_GATEWAY_TOKEN=your-gateway-token
API_SERVER_KEY=sk-wb-your-server-key

# === Feishu (optional) ===
FEISHU_APP_ID=cli_your_app_id
FEISHU_APP_SECRET=your_feishu_app_secret
FEISHU_HOME_CHANNEL=oc_your_channel_id

# === System ===
ROUTER_API_KEY=your-router-key
""")
    print(f"\n✅ Generated .env.example")

    print(f"\n{'='*50}")
    print(f"Sanitization complete!")
    print(f"Files processed: {total_files}")
    print(f"Output: {dst_root}")
    print(f"{'='*50}")

if __name__ == '__main__':
    main()
