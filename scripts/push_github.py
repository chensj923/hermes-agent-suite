#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 GitHub Contents API 推送 git push 的替代方案。逐文件 PUT，不依赖 git 网络。

用法：
  python push_github.py                 # 自动从 git 取待推送文件（未提交 + 最近一次提交）
  python push_github.py path/a path/b   # 显式指定文件

优先级提醒：**先试 `git -c http.sslVerify=false push gh main`**，
本脚本只在 git 网络彻底不通时兜底（它不能删文件、不保留提交历史）。
"""
import base64, json, os, ssl, sys, time, urllib.request, urllib.error, subprocess

ssl._create_default_https_context = ssl._create_unverified_context

TOKEN = (os.environ.get("GITHUB_TOKEN") or "").strip()
REPO = "chensj923/hermes-agent-suite"
API = f"https://api.github.com/repos/{REPO}"
BRANCH = "main"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

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

SKIP_PREFIXES = ("node_modules/", "dist/", ".git/", ".workbuddy/")
SKIP_SUFFIXES = (".exe", ".dll", ".pdb", ".zip", ".tar.gz", ".blockmap", ".node")


def git(*args):
    try:
        out = subprocess.run(["git"] + list(args), cwd=REPO_ROOT,
                             capture_output=True, text=True, timeout=30)
        return out.stdout.strip()
    except Exception:
        return ""


def collect_files():
    """收集待推送文件：工作区未提交的 + 最近一次提交改动的。"""
    names = set()
    # 未跟踪 / 已修改（porcelain 输出去掉状态码，跳过删除 D）
    for line in git("status", "--porcelain").splitlines():
        if len(line) > 3 and not line.startswith("D"):
            names.add(line[3:].strip().strip('"'))
    # 最近一次提交改动的文件
    for line in git("diff", "--name-only", "HEAD~1", "HEAD").splitlines():
        if line.strip():
            names.add(line.strip())

    result = []
    for name in sorted(names):
        rel = name.replace("\\", "/")
        if rel.startswith(SKIP_PREFIXES) or rel.endswith(SKIP_SUFFIXES):
            continue
        if not os.path.exists(os.path.join(REPO_ROOT, rel)):
            continue
        result.append(rel)
    return result


def main():
    if not TOKEN:
        print("GITHUB_TOKEN 未设置"); sys.exit(1)

    # 显式指定优先，否则自动收集
    files = [f.replace("\\", "/") for f in sys.argv[1:]] or collect_files()
    if not files:
        print("没有需要推送的文件"); sys.exit(0)
    print(f"待推送 {len(files)} 个文件")

    ok = 0
    fail = 0
    for f in files:
        local = os.path.join(REPO_ROOT, f.replace("/", os.sep))
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
