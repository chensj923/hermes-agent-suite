#!/usr/bin/env python3
"""
KB Wiki Layer - LLM Wiki 理念落地到本地知识库
1. index.md  - 可读的内容目录
2. log.md    - 增量索引操作日志
3. 交叉引用层 - chunk间 related_ids 关联
4. lint检测  - 孤立/矛盾/过时检测
5. Query综合层 - 检索后LLM综合
"""
import os
import sys
import json
import sqlite3
import time
import hashlib
from datetime import datetime, timedelta
from collections import defaultdict
from typing import List, Dict, Optional

# Add knowledge-base to path
_KB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _KB_DIR)

from config import DB_PATH, FAISS_PATH

WIKI_DIR = _KB_DIR  # wiki root = knowledge-base dir
INDEX_MD = os.path.join(WIKI_DIR, "index.md")
LOG_MD = os.path.join(WIKI_DIR, "log.md")


# ============================================================
# 1. index.md - 自动生成知识库内容目录
# ============================================================

def generate_index():
    """扫描SQLite，生成可读的index.md"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    # 统计
    c.execute("SELECT COUNT(*) FROM chunks")
    chunk_count = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM sources")
    source_count = c.fetchone()[0]
    c.execute("SELECT category, COUNT(*) as cnt FROM sources GROUP BY category ORDER BY cnt DESC")
    cat_stats = [(r["category"] or "other", r["cnt"]) for r in c.fetchall()]

    # 按category列出所有source
    c.execute("""
        SELECT file_path, category, title, chunk_count, indexed_at, file_size
        FROM sources ORDER BY category, title
    """)
    all_sources = [dict(r) for r in c.fetchall()]
    conn.close()

    lines = []
    lines.append("# 知识库索引 (index.md)")
    lines.append("")
    lines.append(f"> 自动生成于 {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"> 源文件: {source_count} | 文本块: {chunk_count} | FAISS向量: 见stats")
    lines.append(f"> 读取此文件了解知识库内容概览，用query做语义检索。")
    lines.append("")

    # 分类统计表
    lines.append("## 分类统计")
    lines.append("")
    lines.append("| 分类 | 文件数 |")
    lines.append("|------|--------|")
    for cat, cnt in cat_stats:
        lines.append(f"| {cat} | {cnt} |")
    lines.append("")

    # 按category分组列出
    by_cat = defaultdict(list)
    for s in all_sources:
        cat = s["category"] or "other"
        by_cat[cat].append(s)

    lines.append("## 内容目录")
    lines.append("")

    for cat in sorted(by_cat.keys()):
        sources = by_cat[cat]
        lines.append(f"### {cat} ({len(sources)} files)")
        lines.append("")
        for s in sources:
            # 一句话摘要：用title + chunk_count
            fname = os.path.basename(s["file_path"])
            title = s["title"] or fname
            chunks = s["chunk_count"] or 0
            idx_time = (s["indexed_at"] or "")[:10]
            size_kb = (s["file_size"] or 0) // 1024
            lines.append(f"- **{title}** ({chunks} chunks, {size_kb}KB, {idx_time})")
            lines.append(f"  `{s['file_path']}`")
        lines.append("")

    content = "\n".join(lines)

    with open(INDEX_MD, "w", encoding="utf-8") as f:
        f.write(content)

    return {
        "path": INDEX_MD,
        "sources": source_count,
        "chunks": chunk_count,
        "categories": len(cat_stats),
    }


# ============================================================
# 2. log.md - 增量索引操作日志 (append-only)
# ============================================================

def append_log(action: str, details: str, files_touched: int = 0,
               vectors_added: int = 0, vectors_total: int = 0):
    """追加一条操作日志"""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    entry = f"## [{ts}] {action}\n"
    entry += f"- {details}\n"
    if files_touched:
        entry += f"- 文件数: {files_touched}\n"
    if vectors_added:
        entry += f"- 新增向量: {vectors_added}\n"
    if vectors_total:
        entry += f"- 向量总数: {vectors_total}\n"
    entry += "\n"

    # 如果文件不存在，创建header
    if not os.path.exists(LOG_MD):
        header = "# 知识库操作日志 (log.md)\n\n"
        header += "> 追加写入，记录每次索引/查询/lint操作。\n"
        header += "> 超过500条时自动轮转为 log-YYYY.md。\n\n"
        with open(LOG_MD, "w", encoding="utf-8") as f:
            f.write(header)

    # 检查是否需要轮转
    with open(LOG_MD, "r", encoding="utf-8") as f:
        line_count = sum(1 for _ in f)
    if line_count > 500:
        # 轮转
        year = datetime.now().year
        archive = LOG_MD.replace("log.md", f"log-{year}.md")
        os.rename(LOG_MD, archive)
        header = "# 知识库操作日志 (log.md)\n\n"
        header += f"> 上一份日志: log-{year}.md\n\n"
        with open(LOG_MD, "w", encoding="utf-8") as f:
            f.write(header)

    with open(LOG_MD, "a", encoding="utf-8") as f:
        f.write(entry)


# ============================================================
# 3. 交叉引用层 - chunk间 related_ids 关联
# ============================================================

def build_cross_references(top_n: int = 5, batch_size: int = 1000):
    """
    为每个chunk找Top-N语义最相似的chunk，存入chunk_relations表。
    用FAISS批量检索实现。
    """
    import faiss
    import numpy as np

    if not os.path.exists(FAISS_PATH):
        return {"error": "FAISS index not found"}

    idx = faiss.read_index(FAISS_PATH)
    if hasattr(idx, "nprobe"):
        idx.nprobe = min(16, idx.nlist)

    total = idx.ntotal
    if total == 0:
        return {"error": "FAISS index empty"}

    # 建表
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS chunk_relations (
            chunk_id INTEGER,
            related_id INTEGER,
            similarity REAL,
            rank INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (chunk_id, related_id)
        )
    """)
    c.execute("DELETE FROM chunk_relations")  # 全量重建
    conn.commit()

    # 分批重建：对每批chunk的embedding，搜索整个FAISS找Top-N
    # 但我们没有存原始embedding，只有FAISS索引
    # 解决：用reconstruct_batch重建向量
    total_inserted = 0

    for start in range(0, total, batch_size):
        end = min(start + batch_size, total)
        # 重建这批向量
        try:
            vectors = np.zeros((end - start, idx.d), dtype=np.float32)
            for i in range(end - start):
                idx.reconstruct(start + i, vectors[i])
        except Exception:
            # IVFPQ不支持reconstruct，用范围搜索替代
            # 退而求其次：只对新索引的chunk做交叉引用
            conn.close()
            return {
                "error": "FAISS index type (IVFPQ) does not support reconstruct. "
                         "Cross-references built incrementally only.",
                "inserted": total_inserted
            }

        # 搜索Top-N+1（包含自己）
        k = top_n + 1
        distances, indices = idx.search(vectors, k)

        for i in range(end - start):
            src_pos = start + i
            # 找到这个position对应的chunk_id
            c.execute("SELECT id FROM chunks WHERE embedding_position = ?", (src_pos,))
            row = c.fetchone()
            if not row:
                continue
            chunk_id = row[0]

            for rank, (dist, idx_pos) in enumerate(zip(distances[i], indices[i])):
                if idx_pos < 0 or idx_pos == src_pos:
                    continue
                c.execute("SELECT id FROM chunks WHERE embedding_position = ?", (int(idx_pos),))
                rel_row = c.fetchone()
                if not rel_row:
                    continue
                related_id = rel_row[0]
                c.execute("""
                    INSERT OR REPLACE INTO chunk_relations (chunk_id, related_id, similarity, rank)
                    VALUES (?, ?, ?, ?)
                """, (chunk_id, related_id, float(dist), rank))
                total_inserted += 1

        conn.commit()
        print(f"  Cross-ref progress: {end}/{total}")

    conn.close()
    return {"inserted": total_inserted, "total_vectors": total}


def build_cross_references_incremental(chunk_ids: List[int], top_n: int = 5):
    """
    增量构建交叉引用：只处理指定的新chunk。
    用新chunk的embedding搜索FAISS找Top-N邻居。
    """
    import faiss
    import numpy as np
    faiss.omp_set_num_threads(1)  # 单线程避免CPU过热

    if not os.path.exists(FAISS_PATH):
        return {"error": "FAISS index not found"}

    idx = faiss.read_index(FAISS_PATH)
    if hasattr(idx, "nprobe"):
        idx.nprobe = min(16, idx.nlist)

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # 确保表存在
    c.execute("""
        CREATE TABLE IF NOT EXISTS chunk_relations (
            chunk_id INTEGER,
            related_id INTEGER,
            similarity REAL,
            rank INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (chunk_id, related_id)
        )
    """)
    conn.commit()

    # 获取这些chunk的embedding_position
    total_inserted = 0
    for chunk_id in chunk_ids:
        c.execute("SELECT embedding_position FROM chunks WHERE id = ?", (chunk_id,))
        row = c.fetchone()
        if not row or row[0] is None:
            continue
        pos = row[0]

        # 重建这个向量
        try:
            vec = np.zeros((1, idx.d), dtype=np.float32)
            idx.reconstruct(pos, vec[0])
        except Exception:
            continue  # IVFPQ不支持reconstruct

        # 搜索Top-N+1
        k = top_n + 1
        distances, indices = idx.search(vec, k)

        for rank, (dist, idx_pos) in enumerate(zip(distances[0], indices[0])):
            if idx_pos < 0 or idx_pos == pos:
                continue
            c.execute("SELECT id FROM chunks WHERE embedding_position = ?", (int(idx_pos),))
            rel_row = c.fetchone()
            if not rel_row:
                continue
            related_id = rel_row[0]
            sim = float(dist)
            # 正向：新chunk -> 旧chunk
            c.execute("""
                INSERT OR REPLACE INTO chunk_relations (chunk_id, related_id, similarity, rank)
                VALUES (?, ?, ?, ?)
            """, (chunk_id, related_id, sim, rank))
            total_inserted += 1
            # 反向：旧chunk -> 新chunk（检查新chunk是否比旧chunk现有最弱关联更相似）
            c.execute("SELECT COUNT(*), MIN(similarity) FROM chunk_relations WHERE chunk_id = ?", (related_id,))
            cnt, min_sim = c.fetchone()
            if cnt is None:
                cnt = 0
            if cnt < top_n:
                # 邻居的关联还没满，直接插入
                c.execute("SELECT COUNT(*) FROM chunk_relations WHERE chunk_id = ? AND related_id = ?", (related_id, chunk_id))
                if c.fetchone()[0] == 0:
                    c.execute("""
                        INSERT OR REPLACE INTO chunk_relations (chunk_id, related_id, similarity, rank)
                        VALUES (?, ?, ?, ?)
                    """, (related_id, chunk_id, sim, top_n - 1))
                    total_inserted += 1
            elif min_sim is not None and sim > min_sim:
                # 新chunk比邻居最弱的关联更相似，挤掉最弱的
                c.execute("SELECT related_id FROM chunk_relations WHERE chunk_id = ? AND similarity = ?", (related_id, min_sim))
                weak_row = c.fetchone()
                if weak_row:
                    c.execute("DELETE FROM chunk_relations WHERE chunk_id = ? AND related_id = ?", (related_id, weak_row[0]))
                    c.execute("""
                        INSERT OR REPLACE INTO chunk_relations (chunk_id, related_id, similarity, rank)
                        VALUES (?, ?, ?, ?)
                    """, (related_id, chunk_id, sim, top_n - 1))
                    total_inserted += 1

    conn.commit()
    conn.close()
    return {"inserted": total_inserted, "chunks_processed": len(chunk_ids)}


def get_related_chunks(chunk_id: int, top_n: int = 5) -> List[Dict]:
    """获取某个chunk的关联chunk"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("""
        SELECT c.id, c.source_file, c.title, c.content, c.category,
               r.similarity, r.rank
        FROM chunk_relations r
        JOIN chunks c ON r.related_id = c.id
        WHERE r.chunk_id = ?
        ORDER BY r.rank
        LIMIT ?
    """, (chunk_id, top_n))
    results = [dict(r) for r in c.fetchall()]
    conn.close()
    return results


# ============================================================
# 4. lint检测 - 孤立/矛盾/过时检测
# ============================================================

def lint():
    """
    知识库健康检查：
    - 孤立chunk: 没有任何交叉引用的chunk
    - 过时source: indexed_at超过90天的source
    - 大文件警告: chunk_count异常多的source
    - 重复检测: title相同的source
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    issues = {
        "orphans": [],       # 没有交叉引用的chunk
        "stale_sources": [], # 过时source
        "large_files": [],   # chunk_count > 50
        "duplicates": [],    # title重复
        "no_embedding": [],  # 没有embedding_position的chunk
    }

    # 检查chunk_relations表是否存在
    c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_relations'")
    has_relations = c.fetchone() is not None

    # 1. 孤立chunk
    if has_relations:
        c.execute("""
            SELECT COUNT(*) FROM chunks c
            LEFT JOIN chunk_relations r ON c.id = r.chunk_id
            WHERE r.chunk_id IS NULL
        """)
        orphan_count = c.fetchone()[0]
        issues["orphans"] = [{"count": orphan_count, "note": "没有交叉引用的chunk"}]
    else:
        issues["orphans"] = [{"count": "N/A", "note": "chunk_relations表不存在，请先运行build-cross-refs"}]

    # 2. 过时source (>90天)
    cutoff = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")
    c.execute("""
        SELECT file_path, category, title, indexed_at
        FROM sources
        WHERE indexed_at < ?
        ORDER BY indexed_at
    """, (cutoff,))
    issues["stale_sources"] = [dict(r) for r in c.fetchall()]

    # 3. 大文件 (chunk_count > 50)
    c.execute("""
        SELECT file_path, category, title, chunk_count
        FROM sources WHERE chunk_count > 50
        ORDER BY chunk_count DESC
    """)
    issues["large_files"] = [dict(r) for r in c.fetchall()]

    # 4. 重复title
    c.execute("""
        SELECT title, COUNT(*) as cnt, GROUP_CONCAT(file_path, ' | ') as paths
        FROM sources
        WHERE title IS NOT NULL AND title != ''
        GROUP BY title HAVING cnt > 1
        ORDER BY cnt DESC
    """)
    issues["duplicates"] = [dict(r) for r in c.fetchall()]

    # 5. 没有embedding的chunk
    c.execute("SELECT COUNT(*) FROM chunks WHERE embedding_position IS NULL")
    no_emb_count = c.fetchone()[0]
    if no_emb_count > 0:
        issues["no_embedding"] = [{"count": no_emb_count}]

    conn.close()

    # 生成报告
    lines = []
    lines.append("# 知识库Lint报告")
    lines.append(f"> 生成于 {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")

    # 孤立chunk
    orphan_info = issues["orphans"][0] if issues["orphans"] else {}
    orphan_count = orphan_info.get("count", 0)
    if isinstance(orphan_count, int) and orphan_count > 0:
        lines.append(f"## ⚠️ 孤立chunk: {orphan_count} 个")
    else:
        lines.append(f"## ✅ 孤立chunk: {orphan_count}")
    if orphan_info.get("note"):
        lines.append(f"   {orphan_info['note']}")
    lines.append("")

    # 过时source
    stale = issues["stale_sources"]
    if stale:
        lines.append(f"## ⚠️ 过时source: {len(stale)} 个 (>90天未更新)")
        for s in stale[:20]:
            lines.append(f"- **{s['title']}** ({s['category']}) - 索引于 {s['indexed_at'][:10]}")
            lines.append(f"  `{s['file_path']}`")
        if len(stale) > 20:
            lines.append(f"  ... 还有 {len(stale)-20} 个")
    else:
        lines.append("## ✅ 过时source: 0")
    lines.append("")

    # 大文件
    large = issues["large_files"]
    if large:
        lines.append(f"## ℹ️ 大文件: {len(large)} 个 (chunk_count > 50)")
        for s in large[:10]:
            lines.append(f"- **{s['title']}** - {s['chunk_count']} chunks")
            lines.append(f"  `{s['file_path']}`")
    else:
        lines.append("## ✅ 大文件: 0")
    lines.append("")

    # 重复title
    dups = issues["duplicates"]
    if dups:
        lines.append(f"## ⚠️ 重复title: {len(dups)} 组")
        for d in dups[:10]:
            lines.append(f"- **{d['title']}** ({d['cnt']}个): {d['paths'][:200]}")
    else:
        lines.append("## ✅ 重复title: 0")
    lines.append("")

    # 无embedding
    no_emb = issues["no_embedding"]
    if no_emb:
        lines.append(f"## ⚠️ 无embedding的chunk: {no_emb[0]['count']} 个")
    else:
        lines.append("## ✅ 无embedding的chunk: 0")
    lines.append("")

    report = "\n".join(lines)

    # 追加到log
    total_issues = 0
    for k, v in issues.items():
        if isinstance(v, list) and v:
            total_issues += len(v)
    append_log("lint", f"发现 {total_issues} 个问题")

    return {"report": report, "issues": issues}


# ============================================================
# 5. Query综合层 - 检索后LLM综合
# ============================================================

def search_with_synthesis(query: str, top_k: int = 10, category: str = None) -> Dict:
    """
    1. FAISS语义检索Top-K
    2. 展开交叉引用（每个结果附带related chunks）
    3. 返回结构化结果，供LLM综合

    不在这里调LLM（避免模型加载延迟），而是返回结构化数据，
    让调用方（Hermes agent）自己做综合。
    """
    try:
        from query import search, get_embedding
        from store import KnowledgeStore
    except ImportError:
        from .query import search, get_embedding
        from .store import KnowledgeStore

    store = KnowledgeStore()

    # 1. FAISS检索
    results = search(store, query, top_k=top_k, category=category)

    # 2. 展开交叉引用
    enriched = []
    for r in results:
        item = dict(r)
        # 找这个chunk的id
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT id FROM chunks WHERE embedding_position = ?",
                  (r.get("embedding_position"),))
        row = c.fetchone()
        if row:
            related = get_related_chunks(row[0], top_n=3)
            item["related"] = [
                {
                    "title": rel["title"],
                    "source_file": rel["source_file"],
                    "content_preview": rel["content"][:200],
                    "similarity": rel["similarity"],
                }
                for rel in related
            ]
        else:
            item["related"] = []
        conn.close()
        enriched.append(item)

    # 3. 追加log
    append_log("query", f"查询: {query[:60]}... | 返回{len(enriched)}条结果")

    return {
        "query": query,
        "results": enriched,
        "total": len(enriched),
        "synthesis_hint": "以下是FAISS检索结果+交叉引用。请基于这些内容综合回答用户问题，"
                          "引用时标注来源文件。如果结果之间有矛盾请指出。",
    }


# ============================================================
# CLI 入口
# ============================================================

def cmd_wiki(args):
    """统一CLI入口"""
    if not args:
        print(__doc__)
        return

    cmd = args[0]

    if cmd == "generate-index":
        result = generate_index()
        print(f"✅ index.md 已生成: {result['path']}")
        print(f"   源文件: {result['sources']} | 文本块: {result['chunks']} | 分类: {result['categories']}")
        append_log("generate-index", f"生成index.md: {result['sources']}源文件, {result['chunks']}文本块")

    elif cmd == "build-cross-refs":
        result = build_cross_references()
        if "error" in result:
            print(f"⚠️ {result['error']}")
            if result.get("inserted"):
                print(f"   已插入 {result['inserted']} 条关系")
        else:
            print(f"✅ 交叉引用构建完成: {result['inserted']} 条关系, {result['total_vectors']} 向量")
            append_log("build-cross-refs", f"构建交叉引用: {result['inserted']}条关系")

    elif cmd == "lint":
        result = lint()
        print(result["report"])

    elif cmd == "search":
        query = " ".join(args[1:]) if len(args) > 1 else ""
        if not query:
            print("用法: kb_wiki.py search \"查询内容\"")
            return
        result = search_with_synthesis(query, top_k=10)
        print(f"\n=== 综合检索: {query} ===")
        print(f"结果数: {result['total']}")
        print(result["synthesis_hint"])
        print()
        for i, r in enumerate(result["results"], 1):
            score = r.get("final_score", r.get("similarity_score", 0))
            print(f"--- 结果 {i} (score={score:.4f}) ---")
            print(f"来源: {r['source_file']}")
            print(f"标题: {r.get('title', '')}")
            print(f"内容: {r['content'][:300]}")
            if r.get("related"):
                print(f"关联chunk ({len(r['related'])}条):")
                for rel in r["related"]:
                    print(f"  → {rel['title']} ({rel['source_file']}) sim={rel['similarity']:.4f}")
            print()

    elif cmd == "log":
        # 显示最近日志
        if os.path.exists(LOG_MD):
            with open(LOG_MD, "r", encoding="utf-8") as f:
                lines = f.readlines()
            # 显示最后30行
            for line in lines[-30:]:
                print(line, end="")
        else:
            print("log.md 不存在")

    elif cmd == "all":
        # 一键执行全部
        print("=== 1. 生成index.md ===")
        r1 = generate_index()
        print(f"   {r1['sources']}源文件, {r1['chunks']}文本块, {r1['categories']}分类")
        append_log("generate-index", f"生成index.md: {r1['sources']}源文件")

        print("\n=== 2. 构建交叉引用 ===")
        r2 = build_cross_references()
        if "error" in r2:
            print(f"   ⚠️ {r2['error']}")
        else:
            print(f"   {r2['inserted']}条关系")
            append_log("build-cross-refs", f"构建交叉引用: {r2['inserted']}条")

        print("\n=== 3. Lint检测 ===")
        r3 = lint()
        print(r3["report"])

        print("\n=== 全部完成 ===")

    else:
        print(f"未知命令: {cmd}")
        print("可用命令: generate-index, build-cross-refs, lint, search, log, all")


if __name__ == "__main__":
    cmd_wiki(sys.argv[1:])
