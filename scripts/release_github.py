#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GitHub Release 发布脚本（urllib，无第三方依赖）。

用法：
  set GITHUB_TOKEN=ghp_xxx
  python release_github.py <tag> <asset_path> [notes_path]

行为：
  1. 查询 release 是否已存在（按 tag）；存在则更新 notes、删除旧 asset。
  2. 不存在则创建（target_commitish=main）。
  3. 上传 asset（同名覆盖）。
"""
import json
import os
import ssl
import sys
import urllib.request

# 本机走 SakuraCat 代理，HTTPS 被 MITM，Python 默认不信任其 CA；仅本发布脚本内跳过校验。
ssl._create_default_https_context = ssl._create_unverified_context

REPO = "chensj923/hermes-agent-suite"
API = f"https://api.github.com/repos/{REPO}"
UPLOAD = f"https://uploads.github.com/repos/{REPO}/releases"


def api_request(url, token, method="GET", data=None, headers=None, raw=False):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "hermes-release-script")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    body = data if isinstance(data, bytes) else (json.dumps(data).encode() if data is not None else None)
    with urllib.request.urlopen(req, data=body, timeout=1800) as resp:
        payload = resp.read()
        return json.loads(payload) if not raw else payload


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    tag, asset_path = sys.argv[1], sys.argv[2]
    notes_path = sys.argv[3] if len(sys.argv) > 3 else None
    token = (os.environ.get("GITHUB_TOKEN") or "").strip()
    if not token:
        print("错误：请先设置 GITHUB_TOKEN 环境变量")
        sys.exit(1)

    notes = ""
    if notes_path and os.path.exists(notes_path):
        with open(notes_path, "r", encoding="utf-8") as f:
            notes = f.read()

    # 1) 找已有 release
    release = None
    try:
        release = api_request(f"{API}/releases/tags/{tag}", token)
        print(f"release 已存在：id={release['id']}")
    except Exception:
        body = {
            "tag_name": tag,
            "target_commitish": "main",
            "name": f"Hermes Buddy {tag}",
            "body": notes or f"Hermes Buddy {tag}",
            "draft": False,
            "prerelease": "-dev" in tag,
        }
        release = api_request(f"{API}/releases", token, method="POST", data=body)
        print(f"release 已创建：id={release['id']}")

    # 2) 更新 notes
    if notes:
        api_request(f"{API}/releases/{release['id']}", token, method="PATCH", data={"body": notes})
        print("notes 已更新")

    # 3) 删除旧 asset（同名）
    asset_name = os.path.basename(asset_path)
    for asset in release.get("assets", []):
        if asset.get("name") == asset_name:
            api_request(f"{API}/releases/assets/{asset['id']}", token, method="DELETE")
            print(f"旧 asset 已删除：{asset_name}")

    # 4) 上传
    size = os.path.getsize(asset_path)
    print(f"上传 {asset_name}（{size} 字节）…")
    with open(asset_path, "rb") as f:
        data = f.read()
    url = f"{UPLOAD}/{release['id']}/assets?name={asset_name}"
    api_request(url, token, method="POST", data=data,
                headers={"Content-Type": "application/octet-stream"})
    print("asset 上传完成")
    print(f"发布页：{release.get('html_url', '')}")


if __name__ == "__main__":
    main()
