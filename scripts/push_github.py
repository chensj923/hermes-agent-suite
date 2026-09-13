#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 GitHub Contents API 推送 git push 的替代方案。
逐文件 PUT，不依赖 git 网络。"""
import base64, json, os, ssl, sys, time, urllib.request, urllib.error

ssl._create_default_https_context = ssl._create_unverified_context

TOKEN = (os.environ.get("GITHUB_TOKEN") or "").strip()
REPO = "chensj923/hermes-agent-suite"
API = f"https://api.github.com/repos/{REPO}"
BRANCH = "main"

def call(url, method="GET", data=None, headers=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "hermes-push")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    body = data if isinstance(data, (bytes, bytearray)) else (json.dumps(data).encode() if data is not None else None)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, data=body, timeout=120) as r:
                return r.status, json.loads(r.read()) if r.headers.get("content-type", "").startswith("application/json") else r.read()
        except urllib.error.HTTPError as e:
            if e.code in (409, 422) and attempt < 2:
                time.sleep(2)
                continue
            return e.code, e.read()
        except Exception as e:
            if attempt < 2:
                time.sleep(3)
                continue
            raise

def get_file_sha(path):
    """获取远端文件的当前 sha（用于更新已有文件）。"""
    status, data = call(f"{API}/contents/{path}?ref={BRANCH}")
    if status == 200 and isinstance(data, dict):
        return data.get("sha")
    return None

def push_file(local_path, repo_path):
    """上传单个文件到 GitHub。"""
    with open(local_path, "rb") as f:
        content = base64.b64encode(f.read()).decode()
    sha = get_file_sha(repo_path)
    payload = {
        "message": f"push {repo_path}",
        "content": content,
        "branch": BRANCH,
    }
    if sha:
        payload["sha"] = sha
    status, data = call(f"{API}/contents/{repo_path}", method="PUT", data=payload)
    return status, data

def main():
    if not TOKEN:
        print("GITHUB_TOKEN 未设置"); sys.exit(1)

    # 仓库根
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    
    # 要推送的文件列表（相对仓库根）
    files = [
        "apps/hermes-buddy-desktop/package.json",
        "apps/hermes-buddy-desktop/src/fetch-lenient.js",
        "apps/hermes-buddy-desktop/src/connection-store.js",
        "apps/hermes-buddy-desktop/src/main.js",
        "apps/hermes-buddy-desktop/src/session-manager.js",
        "apps/hermes-buddy-desktop/src/update-checker.js",
        "apps/hermes-buddy-desktop/src/updater.js",
        "apps/hermes-buddy-desktop/src/renderer/app.js",
        "apps/hermes-buddy-desktop/src/renderer/styles.css",
        "apps/hermes-buddy-desktop/src/renderer/index.html",
        "apps/hermes-buddy-desktop/src/preload.js",
        "apps/hermes-buddy-desktop/src/agent-store.js",
        "apps/hermes-buddy-desktop/src/agent/brain.js",
        "apps/hermes-buddy-desktop/src/agent/loop.js",
        "apps/hermes-buddy-desktop/src/tools/guard.js",
        "apps/hermes-buddy-desktop/src/tools/index.js",
        "apps/hermes-buddy-desktop/src/tools/shell.js",
        "apps/hermes-buddy-desktop/src/tools/files.js",
        "apps/hermes-buddy-desktop/src/workspace.js",
        "apps/hermes-buddy-desktop/src/diagnostics.js",
        "apps/hermes-buddy-desktop/src/server-bootstrap.js",
        "apps/hermes-buddy-desktop/src/memory.js",
        "apps/hermes-buddy-desktop/src/skills.js",
        "apps/hermes-buddy-desktop/src/toolchain.js",
        "apps/hermes-buddy-desktop/src/logger.js",
        "apps/hermes-buddy-desktop/src/agent-loop.js",
        "scripts/release_github.py",
        "scripts/build-buddy-windows.ps1",
    ]

    ok = 0
    fail = 0
    for f in files:
        local = os.path.join(repo_root, f.replace("/", os.sep))
        if not os.path.exists(local):
            print(f"SKIP (not found): {f}")
            continue
        try:
            status, data = push_file(local, f)
            if status in (200, 201):
                print(f"OK: {f}")
                ok += 1
            else:
                print(f"FAIL({status}): {f} - {data[:200] if isinstance(data, (bytes, bytearray)) else str(data)[:200]}")
                fail += 1
        except Exception as e:
            print(f"ERROR: {f} - {e}")
            fail += 1
        time.sleep(0.5)  # GitHub API rate limit

    print(f"\nDone: {ok} ok, {fail} fail")

if __name__ == "__main__":
    main()
