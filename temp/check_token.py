import json, urllib.request, urllib.error, os, sys, ssl

# 本机走 SakuraCat 代理，HTTPS 被 MITM，Python 默认不信任其 CA；仅本发布脚本内跳过校验。
ssl._create_default_https_context = ssl._create_unverified_context

TOKEN = (os.environ.get("GITHUB_TOKEN") or "").strip()
print("token len:", len(TOKEN))

def call(url, method="GET", data=None, headers=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "hermes-check")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    body = data if isinstance(data, (bytes, bytearray)) else (json.dumps(data).encode() if data is not None else None)
    try:
        with urllib.request.urlopen(req, data=body, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

s, b = call("https://api.github.com/user")
print("user status:", s, b[:200])

s, b = call("https://api.github.com/repos/chensj923/hermes-agent-suite")
print("repo status:", s)
if s == 200:
    j = json.loads(b)
    print("repo:", j.get("full_name"), "private:", j.get("private"))
    print("default_branch:", j.get("default_branch"))

s, b = call("https://api.github.com/repos/chensj923/hermes-agent-suite/commits/main")
print("main status:", s)
if s == 200:
    j = json.loads(b)
    print("main head:", j.get("sha"), (j.get("commit") or {}).get("message", "").split("\n")[0])
