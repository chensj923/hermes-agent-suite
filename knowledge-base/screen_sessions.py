#!/usr/bin/env python3
"""
会话筛选器：扫描最近 N 天的 Hermes 会话，启发式评分，高价值会话向量化写入 FAISS。
不再依赖 LM Studio（本地 bge-base-zh-v1.5 + 启发式评分）。
"""
import os, sys, json, re
from datetime import datetime, timedelta
from pathlib import Path
import numpy as np

sys.path.insert(0, os.path.expanduser("~/.hermes/knowledge-base"))
try:
    from config import LOCAL_EMBEDDING_PATH, KB_DATA_DIR
except ImportError:
    LOCAL_EMBEDDING_PATH = os.path.expanduser("~/.cache/modelscope/BAAI/bge-base-zh-v1___5")
    KB_DATA_DIR = os.path.expanduser("~/.hermes/knowledge-base/kb_data")

from sentence_transformers import SentenceTransformer
import faiss
import sqlite3

SESSIONS_DIR = Path(os.path.expanduser("~/.hermes/sessions"))
SESSIONS_DB_PATH = Path(KB_DATA_DIR) / "sessions_db.json"
FAISS_PATH = Path(KB_DATA_DIR) / "vectors.faiss"
SCAN_DAYS = 30
MAX_PROCESS = 10
HIGH_SCORE_THRESHOLD = 7


def load_sessions():
    cutoff = datetime.now() - timedelta(days=SCAN_DAYS)
    sessions = []
    for fp in sorted(SESSIONS_DIR.glob("*.jsonl")):
        try:
            date_str = fp.stem.split("_")[0]
            file_date = datetime.strptime(date_str, "%Y%m%d")
            if file_date < cutoff:
                continue
            messages = []
            with open(fp, encoding="utf-8") as f:
                for line in f:
                    msg = json.loads(line)
                    if "content" in msg and "role" in msg:
                        messages.append(msg)
            if messages:
                sessions.append({"file": str(fp), "date": file_date, "messages": messages, "length": len(messages)})
        except Exception as e:
            print(f"  skip {fp.name}: {e}")
    return sorted(sessions, key=lambda x: x["date"], reverse=True)


def heuristic_score(session):
    """纯启发式评分，不依赖 LLM"""
    msgs = session["messages"]
    user_msgs = [m for m in msgs if m.get("role") == "user" and len(m.get("content", "")) > 10]
    
    score = 5  # baseline
    # 工具调用丰富度
    tool_roles = {"tool_calls", "tool_result", "assistant"}
    tool_count = sum(1 for m in msgs if m.get("role") in tool_roles and "tool_calls" in str(m))
    if tool_count > 10:
        score += 3
    elif tool_count > 5:
        score += 2
    elif tool_count > 2:
        score += 1
    
    # 对话长度
    if session["length"] > 80:
        score += 2
    elif session["length"] > 40:
        score += 1
    
    # 是否涉及代码/配置/故障排查
    combined = " ".join(m.get("content", "") for m in msgs if isinstance(m.get("content"), str))
    code_keywords = ["python", "config", "error", "debug", "修复", "配置", "模型", "API", "部署", "FAISS", "embedding"]
    code_hits = sum(1 for kw in code_keywords if kw.lower() in combined.lower())
    if code_hits >= 5:
        score += 2
    elif code_hits >= 2:
        score += 1
    
    # 是否有明确解决/结论
    if any(w in combined for w in ["完成", "成功", "✅", "Done", "已修复", "已配置"]):
        score += 1
    
    # 提取标题
    title = user_msgs[0]["content"][:60] if user_msgs else "未知会话"
    summary = f"工具调用 {tool_count} 次，共 {session['length']} 条消息"
    
    return {"title": title.strip(), "summary": summary, "score": min(score, 10)}


def save_to_db(entries):
    existing = []
    if SESSIONS_DB_PATH.exists():
        try:
            existing = json.loads(SESSIONS_DB_PATH.read_text(encoding="utf-8")).get("sessions", [])
        except Exception:
            pass
    
    existing_files = {e["file"] for e in existing}
    for s in entries:
        if s["file"] not in existing_files:
            existing.append({
                "file": s["file"],
                "date": s["date"].isoformat() if isinstance(s["date"], datetime) else s["date"],
                "title": s["title"],
                "summary": s["summary"],
                "score": s["score"],
            })
    
    existing = sorted(existing, key=lambda x: x["score"], reverse=True)[:100]
    
    SESSIONS_DB_PATH.write_text(
        json.dumps({"sessions": existing, "metadata": {"last_updated": datetime.now().isoformat()}},
                   ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"  sessions_db.json updated ({len(existing)} entries)")


def embed_and_index(entries):
    """用本地 bge-base-zh-v1.5 嵌入摘要，加入主 FAISS 索引"""
    model = SentenceTransformer(LOCAL_EMBEDDING_PATH)  # eager load
    
    # 对 score>=7 的条目生成摘要文本
    high_entries = [e for e in entries if e["score"] >= HIGH_SCORE_THRESHOLD]
    if not high_entries:
        print("  no high-score sessions to embed")
        return
    
    texts = [f"{e['title']}: {e['summary']}" for e in high_entries]
    embs = model.encode(texts, normalize_embeddings=True)
    
    idx = faiss.read_index(str(FAISS_PATH))
    idx.add(np.array(embs, dtype=np.float32))
    faiss.write_index(idx, str(FAISS_PATH))
    print(f"  indexed {len(high_entries)} sessions → FAISS ({idx.ntotal} total)")


def main():
    print(f"Session Screener (local) — scanning {SCAN_DAYS}d")
    sessions = load_sessions()
    print(f"  found {len(sessions)} sessions")
    
    if not sessions:
        print("  nothing to process")
        return
    
    sessions = sessions[:MAX_PROCESS]
    print(f"  processing top {len(sessions)}")
    
    scored = []
    for i, s in enumerate(sessions):
        result = heuristic_score(s)
        print(f"  [{i+1}/{len(sessions)}] score={result['score']}  {result['title'][:50]}")
        scored.append({"file": s["file"], "date": str(s["date"]), "title": result["title"],
                        "summary": result["summary"], "score": result["score"]})
    
    save_to_db(scored)
    
    high = [s for s in scored if s["score"] >= HIGH_SCORE_THRESHOLD]
    print(f"  high-value (≥{HIGH_SCORE_THRESHOLD}): {len(high)}")
    if high:
        embed_and_index(high)


if __name__ == "__main__":
    main()
