#!/usr/bin/env python3
"""
快速索引工具 - 使用批量 embedding API
扫描所有源文件，提取文本块，批量向量化并写入 FAISS
"""
import sys, os, json, time, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sqlite3
import numpy as np
import faiss
from sentence_transformers import SentenceTransformer
from config import (
    LOCAL_EMBEDDING_PATH,
    SOURCE_DIRS, INDEX_PATTERNS, SKIP_PATTERNS, CHUNK_SIZE
)

DB_PATH = "/root/.hermes/knowledge-base/kb_data/knowledge.db"
FAISS_PATH = "/root/.hermes/knowledge-base/kb_data/vectors.faiss"
BATCH_SIZE = 64  # Larger batch for speed

_embedder = None

def _get_embedder():
    global _embedder
    if _embedder is None:
        print(f"Loading embedding model from {LOCAL_EMBEDDING_PATH} ...")
        _embedder = SentenceTransformer(LOCAL_EMBEDDING_PATH)
        print(f"  dim={_embedder.get_embedding_dimension()}")
    return _embedder


def split_text(text):
    """智能文本分块"""
    if not text or len(text.strip()) < 20:
        return []
    
    lines = text.split('\n')
    paragraphs = []
    current = []
    
    for line in lines:
        if line.startswith('# ') and current and len('\n'.join(current)) > 30:
            paragraphs.append('\n'.join(current))
            current = [line]
        elif line.startswith('## ') and current and len('\n'.join(current)) > 30:
            paragraphs.append('\n'.join(current))
            current = [line]
        elif line.strip() == '' and current and len('\n'.join(current)) > 50:
            paragraphs.append('\n'.join(current))
            current = []
        else:
            current.append(line)
    
    if current and len('\n'.join(current)) > 20:
        paragraphs.append('\n'.join(current))
    
    # Further split large paragraphs
    chunks = []
    for para in paragraphs:
        if len(para) <= CHUNK_SIZE * 4:
            chunks.append(para.strip())
        else:
            words = para.split()
            current_chunk = []
            current_len = 0
            for word in words:
                current_chunk.append(word)
                current_len += len(word) + 1
                if current_len >= CHUNK_SIZE:
                    chunks.append(' '.join(current_chunk))
                    current_chunk = current_chunk[-16:]
                    current_len = sum(len(w) + 1 for w in current_chunk)
            if current_chunk:
                chunks.append(' '.join(current_chunk))
    
    return [c.strip() for c in chunks if len(c.strip()) > 20]


def detect_category(file_path):
    if "skills" in file_path:
        skill_name = file_path.split("skills/")[-1].split("/")[0]
        return f"skill:{skill_name}"
    elif "memories" in file_path or "MEMORY.md" in file_path:
        return "memory"
    elif "USER.md" in file_path:
        return "user-profile"
    elif "scripts" in file_path:
        return "script"
    elif "plugins" in file_path:
        return "plugin"
    elif "config" in file_path.lower():
        return "config"
    else:
        return "other"


def detect_title(file_path):
    basename = os.path.basename(file_path)
    name = os.path.splitext(basename)[0]
    title = name.replace("-", " ").replace("_", " ").title()
    if basename.endswith(".md"):
        title += " (文档)"
    elif basename.endswith(".py"):
        title += " (脚本)"
    elif basename.endswith((".yaml", ".yml")):
        title += " (配置)"
    return title


def batch_get_embeddings(texts):
    """Batch embed using local SentenceTransformer (bge-base-zh-v1.5, 768-dim)"""
    try:
        model = _get_embedder()
        embs = model.encode(texts, normalize_embeddings=True, batch_size=BATCH_SIZE)
        return [list(e) for e in embs]
    except Exception as e:
        print(f"  [BATCH ERROR] {e}")
    return None


def fast_index():
    """快速全量索引"""
    # Ensure DB schema exists
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_file TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            category TEXT,
            title TEXT,
            content TEXT NOT NULL,
            metadata TEXT,
            embedding_id INTEGER,
            embedding_position INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(source_file, chunk_index)
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS sources (
            file_path TEXT PRIMARY KEY,
            category TEXT,
            title TEXT,
            file_size INTEGER,
            last_modified REAL,
            chunk_count INTEGER DEFAULT 0,
            indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS index_meta (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    conn.commit()
    conn.close()
    
    # Connect to DB
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    # Load existing sources
    c.execute("SELECT file_path, last_modified FROM sources")
    db_files = {r[0]: r[1] for r in c.fetchall()}
    conn.close()
    
    # Scan files
    all_files = []
    for src_dir in SOURCE_DIRS:
        if not os.path.exists(src_dir):
            continue
        for pattern in INDEX_PATTERNS:
            for filepath in glob.glob(os.path.join(src_dir, "**", pattern), recursive=True):
                skip = any(sp in filepath for sp in SKIP_PATTERNS)
                if not skip:
                    all_files.append(filepath)
    
    # Filter to new/changed files
    to_index = []
    for fpath in all_files:
        try:
            mtime = os.path.getmtime(fpath)
        except:
            continue
        if fpath not in db_files or abs(mtime - db_files[fpath]) > 1:
            to_index.append((fpath, mtime))
    
    print(f"Files to index: {len(to_index)} (total available: {len(all_files)})")
    
    if not to_index:
        print("No new or changed files.")
        return {"new": 0, "updated": 0, "total_chunks": 0}
    
    # Extract chunks
    all_chunks = []  # [(file_path, chunk_index, category, title, content)]
    for fpath, mtime in to_index:
        try:
            content = open(fpath, "r", encoding="utf-8", errors="replace").read()
        except:
            continue
        chunks = split_text(content)
        if not chunks:
            continue
        cat = detect_category(fpath)
        title = detect_title(fpath)
        for i, chunk in enumerate(chunks):
            all_chunks.append((fpath, i, cat, title, chunk))
    
    print(f"Total chunks to embed: {len(all_chunks)}")
    
    # Batch embed
    all_vectors = []
    all_chunk_info = []
    total = len(all_chunks)
    
    for batch_start in range(0, total, BATCH_SIZE):
        batch = all_chunks[batch_start:batch_start + BATCH_SIZE]
        batch_texts = [ch[4] for ch in batch]
        
        embs = batch_get_embeddings(batch_texts)
        
        if embs:
            all_vectors.extend(embs)
            all_chunk_info.extend(batch)
            success = len(embs)
        else:
            success = 0
        
        print(f"  Embedding progress: {batch_start + success}/{total} (vectors={len(all_vectors)})")
        
        if (batch_start + BATCH_SIZE) % 500 == 0:
            time.sleep(1)
    
    if not all_vectors:
        print("No successful embeddings.")
        return {"new": 0, "updated": 0, "total_chunks": 0}
    
    # Save to DB
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    chunk_ids = []
    for fpath, chunk_idx, cat, title, content in all_chunk_info:
        c.execute("""
            INSERT OR REPLACE INTO chunks 
            (source_file, chunk_index, category, title, content, metadata)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (fpath, chunk_idx, cat, title, content, None))
        chunk_ids.append(c.lastrowid)
    conn.commit()
    
    # Update sources
    for fpath, mtime in to_index:
        chunks_for_file = [ch for ch in all_chunk_info if ch[0] == fpath]
        c.execute("""
            INSERT INTO sources (file_path, category, title, file_size, last_modified, chunk_count, indexed_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(file_path) DO UPDATE SET
                category=excluded.category, title=excluded.title,
                last_modified=excluded.last_modified, chunk_count=excluded.chunk_count,
                indexed_at=CURRENT_TIMESTAMP
        """, (fpath, detect_category(fpath), detect_title(fpath), 
              os.path.getsize(fpath), mtime, len(chunks_for_file)))
    conn.commit()
    conn.close()
    
    # Build FAISS index
    vecs = np.array(all_vectors, dtype=np.float32)
    dim = vecs.shape[1]
    
    if os.path.exists(FAISS_PATH):
        idx = faiss.read_index(FAISS_PATH)
        print(f"Loaded existing FAISS: {idx.ntotal} vectors, dim={idx.d}")
        if idx.d != dim:
            print(f"  Dimension mismatch! Rebuilding...")
            idx = faiss.IndexFlatIP(dim)
    else:
        idx = faiss.IndexFlatIP(dim)
    
    # Record positions
    start_pos = idx.ntotal
    positions = list(range(start_pos, start_pos + len(vecs)))
    
    # Normalize and add
    faiss.normalize_L2(vecs)
    idx.add(vecs)
    faiss.write_index(idx, FAISS_PATH)
    
    # Save position mapping
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    for chunk_id, pos in zip(chunk_ids, positions):
        c.execute("UPDATE chunks SET embedding_position = ? WHERE id = ?", (pos, chunk_id))
    conn.commit()
    conn.close()
    
    new_count = sum(1 for f, _ in to_index if f not in db_files)
    updated = len(to_index) - new_count

    print(f"\nDone: +{new_count} ~{updated} files, {len(all_vectors)} vectors, total FAISS={idx.ntotal}")

    # === Wiki Layer 集成 ===
    try:
        from kb_wiki import append_log, generate_index, build_cross_references_incremental
        # 1. 追加操作日志
        append_log(
            "index",
            f"增量索引: +{new_count} 新, ~{updated} 更新",
            files_touched=len(to_index),
            vectors_added=len(all_vectors),
            vectors_total=idx.ntotal
        )
        # 2. 增量构建交叉引用（只处理新chunk）
        if chunk_ids:
            cr = build_cross_references_incremental(chunk_ids, top_n=5)
            print(f"  Cross-refs: {cr.get('inserted', 0)} relations for {cr.get('chunks_processed', 0)} chunks")
            append_log("cross-refs", f"增量交叉引用: {cr.get('inserted', 0)}条")
        # 3. 刷新index.md
        gi = generate_index()
        print(f"  index.md refreshed: {gi['sources']} sources, {gi['categories']} categories")
    except Exception as e:
        print(f"  [WARN] Wiki layer integration failed: {e}")

    # === 刷新关键词文件（供 kb_context 插件触发检测） ===
    try:
        _refresh_trigger_keywords()
        print(f"  trigger_keywords.json refreshed")
    except Exception as e:
        print(f"  [WARN] keyword refresh failed: {e}")


def _refresh_trigger_keywords():
    """从 DB 元数据提取关键词，更新 trigger_keywords.json 供插件使用。"""
    import re
    from collections import Counter

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT file_path, title, category FROM sources")
    rows = c.fetchall()
    c.execute("SELECT content FROM chunks")
    all_contents = [r[0] for r in c.fetchall()]
    conn.close()

    # 英文停用词
    EN_STOP = set('''the a an is are was were be been being have has had do does did will would
    could should may might can must shall to of in on at for with by from as into about through
    during and or but if then else when while because so that this that these those it its their
    our your his her my we you they i me him us them not no nor only own same such too very just
    more most other some any all each few both many much several how what which who whom whose
    where why when there here than then also been just now will can may def class import return
    if else for while try except with as pass true false none null init main config setup utils
    helpers common general base core data types models views routes handlers middleware index app
    run start stop get set add remove create delete update edit load save open close read write
    check test debug log info error warn file dir path name type size count list array dict map
    str int float bool src lib bin docs doc tmp temp cache backup old new md py yaml yml json txt
    sh bash conf cfg ini xml html css js ts spec reference refs templates scripts assets
    '''.split())

    # 中文停用词
    CN_STOP = set('的 了 是 在 和 与 或 也 都 就 还 又 再 把 被 让 使 给 对 从 向 往 以 于 为 由 按'
                  ' 这 那 它 它们 他 她 我 你 您 我们 你们 他们 自己 什么 怎么'
                  ' 使用 用于 关于 通过 对于 一个 一些 每个 所有 上述 下方 上方 之前 之后 其中'
                  ' 不 没 没有 有 得 地 着 过 来 去 上 下 中 内 外 前 后 左 右'.split())

    # 中文通用词 (不具备领域区分性)
    CN_GENERIC = set('''问题 处理 设置 检查 运行 系统 功能 操作 方法 说明 配置 文档 脚本
    不能 不会 没有 已经 进行 相关 以下 以上 以及 这些 那些 内容 数据 代码 文件 结果 信息
    部分 类型 方式 状态 版本 环境 正常 异常 错误 成功 失败 完成 开始 结束 添加 删除 修改
    查询 用户 密码 账号 名称 标题 列表 页面 界面 按钮 菜单 前端 后端 数据库 服务 端口
    路径 目录 域名 地址 链接 步骤 流程 逻辑 规则 条件 参数 选项 属性 字段 启动 停止
    重启 加载 保存 导出 导入 上传 下载 安装 卸载 测试 调试 编译 构建 打包 部署 发布
    更新 升级 确认 验证 执行 创建 编辑 查看 打开 关闭 天气 今天 昨天 明天 现在 以后
    以前 大家 可能 已经 应该 还是 这样 那样 什么 怎么 为什么 哪里 的话 一下 看看 试试
    好的 可以 需要 不过 其实 感觉 觉得 知道 东西 地方 时候 时间 直接 间接 自动 手动
    完全 部分 全部 局部'''.split())

    # 英文通用词
    EN_GENERIC = set('''action actions adapter adapters add advanced agent agents api apk app
    apple architecture array article asset assets async auth author auto backend backends
    background bad balance base basic batch battle behavior benchmark binary block blocks
    board body bold bot bridge browser bug build cache call camera canvas capture card case
    catalog chain channel character chat check chunk clean client clip cloud code codebase
    collection color column combat combo command commands commit common compact compose
    config configuration conflict connect console container content context control convert
    copy core count create cross custom data database dataset date day dead debug default
    delete deploy deployment description design detail detect dev development device diagram
    diff document documents draft drop dynamic edge edit editor effect effects element email
    empty enable enabled end engine entry env error escape event events example examples
    execute export extension extract face fail failure false feature features feed field
    file files filter find first fix flag flow folder font format frame framework function
    gateway generate generation generic get given global goal grid group guide header health
    height help here hook hooks host html identity image images import info input inputs
    insert install instance int integration issue issues item items json key label language
    large last layer layers layout learn level limit line link list load local location lock
    log logging logs loop machine main manage management manager manual map marker master
    match merge message metadata method methods migrate migration model models module modules
    monitor move multi name names native need net network new node none normal note notes
    null number object offline online open option options order origin output overlay override
    package page pair panel parallel param parent parse parsing path pattern patterns pause
    pipe pipeline plan planning plugin plugins pop port post prefix preset primary print
    priority process profile program project properties protocol provider proxy public push
    quality query queue random range rate raw read receive redirect redo reduce reference
    refresh release remote remove rename render report reports request require requirement
    reset resource response rest result retry return review role root route row rule rules
    run running runtime sample scale scan scene schema scope screen script search secret
    section select self send sensor sequence serial server service session set setting
    settings setup sheet show side signal silent size skip slot slow smart source space spec
    specific speed stack stage standard start state status step stop store string style sub
    submit summary support sync system tag target task tasks team temp template test testing
    text time timeout token tool tools top track transform tree trigger true type types
    unicode unit update upgrade upload url user valid value variable variant version video
    view visual vote wait warning web work worker workspace write zone'''.split())

    def extract_en(text):
        terms = set()
        for m in re.finditer(r'[A-Za-z][A-Za-z0-9_\-\.]{2,}', text):
            word = m.group().lower().rstrip('.')
            if word not in EN_STOP and word not in EN_GENERIC and len(word) >= 3:
                terms.add(word)
        return terms

    def extract_cn(text):
        terms = set()
        for m in re.finditer(r'[\u4e00-\u9fff]{2,4}', text):
            word = m.group()
            if word not in CN_STOP and word not in CN_GENERIC:
                terms.add(word)
        return terms

    keywords = set()

    for file_path, title, category in rows:
        if category:
            parts = category.replace('skill:', '').replace(':', ' ').replace('-', ' ').replace('_', ' ')
            keywords |= extract_en(parts)
        if file_path:
            basename = os.path.basename(file_path)
            name_no_ext = os.path.splitext(basename)[0]
            for part in file_path.split('/')[-4:]:
                part_clean = part.replace('-', ' ').replace('_', ' ').replace('.', ' ')
                keywords |= extract_en(part_clean)
        if title:
            keywords |= extract_en(title)

    # 从内容提取高频中文词
    cn_counter = Counter()
    for content in all_contents:
        for term in extract_cn(content):
            cn_counter[term] += 1
    for word, cnt in cn_counter.most_common():
        if cnt >= 3:
            keywords.add(word)
        else:
            break

    # 从内容提取高频英文词
    en_counter = Counter()
    for content in all_contents:
        for term in extract_en(content):
            en_counter[term] += 1
    for word, cnt in en_counter.most_common():
        if cnt >= 3:
            keywords.add(word)
        else:
            break

    out_path = os.path.join(os.path.dirname(DB_PATH), "trigger_keywords.json")
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(sorted(keywords), f, ensure_ascii=False)


if __name__ == "__main__":
    fast_index()
