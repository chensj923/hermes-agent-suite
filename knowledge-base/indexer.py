"""
文本索引器 - 文件扫描、分块、embedding 生成
使用本地 sentence-transformers 模型生成 embedding
"""
import os
import glob
import hashlib
import time
import sqlite3
import numpy as np
import faiss
from typing import List, Dict, Optional

try:
    from config import (
        LOCAL_EMBEDDING_PATH, CHUNK_SIZE, CHUNK_OVERLAP,
        SOURCE_DIRS, INDEX_PATTERNS, SKIP_PATTERNS
    )
except ImportError:
    from .config import (
        LOCAL_EMBEDDING_PATH, CHUNK_SIZE, CHUNK_OVERLAP,
        SOURCE_DIRS, INDEX_PATTERNS, SKIP_PATTERNS
    )

# Lazy load sentence-transformers model
_embedding_model = None

def get_embedding_model():
    global _embedding_model
    if _embedding_model is None:
        from sentence_transformers import SentenceTransformer
        _embedding_model = SentenceTransformer(LOCAL_EMBEDDING_PATH)
    return _embedding_model


def split_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> List[str]:
    """
    智能文本分块：按段落/标题分割，保持语义完整性
    """
    if not text or len(text.strip()) < 10:
        return []

    # First split by headers (markdown)
    lines = text.split('\n')
    paragraphs = []
    current = []

    for line in lines:
        if line.startswith('# ') and current:
            paragraphs.append('\n'.join(current))
            current = [line]
        elif line.startswith('## ') and current:
            paragraphs.append('\n'.join(current))
            current = [line]
        elif line.startswith('### ') and current:
            paragraphs.append('\n'.join(current))
            current = [line]
        elif line.strip() == '' and current and len('\n'.join(current)) > 50:
            paragraphs.append('\n'.join(current))
            current = []
        else:
            current.append(line)

    if current:
        paragraphs.append('\n'.join(current))

    # Filter out very short paragraphs
    paragraphs = [p for p in paragraphs if len(p.strip()) > 20]

    # Further split large paragraphs
    chunks = []
    for para in paragraphs:
        if len(para) <= chunk_size * 4:
            chunks.append(para)
        else:
            # Split by sentences (rough)
            words = para.split()
            current_chunk = []
            current_len = 0
            for word in words:
                current_chunk.append(word)
                current_len += len(word) + 1
                if current_len >= chunk_size:
                    chunks.append(' '.join(current_chunk))
                    # Keep overlap
                    overlap_words = current_chunk[-overlap//4:] if overlap > 0 else []
                    current_chunk = overlap_words
                    current_len = sum(len(w) + 1 for w in current_chunk)
            if current_chunk:
                chunks.append(' '.join(current_chunk))

    return chunks


def detect_category(file_path: str) -> str:
    """根据文件路径检测类别"""
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


def detect_title(file_path: str) -> str:
    """从文件名生成标题"""
    basename = os.path.basename(file_path)
    name = os.path.splitext(basename)[0]
    # Replace hyphens/underscores with spaces, capitalize
    title = name.replace("-", " ").replace("_", " ").title()
    if basename.endswith(".md"):
        title += " (文档)"
    elif basename.endswith(".py"):
        title += " (脚本)"
    elif basename.endswith((".yaml", ".yml")):
        title += " (配置)"
    return title


def get_embedding(text: str) -> Optional[List[float]]:
    """通过本地 sentence-transformers 模型获取文本 embedding"""
    try:
        model = get_embedding_model()
        embedding = model.encode(text, normalize_embeddings=True)
        return embedding.tolist()
    except Exception as e:
        print(f"  [ERROR] Embedding failed: {e}")
        return None


def index_file(file_path: str, store) -> List[Dict]:
    """
    索引单个文件
    Returns: list of chunk dicts with embeddings
    """
    try:
        content = open(file_path, "r", encoding="utf-8", errors="replace").read()
    except Exception as e:
        print(f"  [ERROR] Cannot read {file_path}: {e}")
        return []

    if len(content.strip()) < 20:
        return []

    chunks = split_text(content)
    if not chunks:
        return []

    category = detect_category(file_path)
    title = detect_title(file_path)

    indexed_chunks = []
    for i, chunk in enumerate(chunks):
        chunk_dict = {
            "source_file": file_path,
            "chunk_index": i,
            "category": category,
            "title": title,
            "content": chunk.strip(),
            "metadata": {"file_size": len(content), "word_count": len(chunk.split())}
        }

        # Generate embedding
        embedding = get_embedding(chunk_dict["content"])
        if embedding:
            indexed_chunks.append(chunk_dict)
        else:
            print(f"  [WARN] No embedding for chunk {i} in {file_path}")

    return indexed_chunks


def index_all(store, source_dirs: List[str] = None, skip_patterns: List[str] = None):
    """
    全量索引所有源文件
    Returns: stats dict
    """
    if source_dirs is None:
        source_dirs = SOURCE_DIRS
    if skip_patterns is None:
        skip_patterns = SKIP_PATTERNS

    import glob

    all_files = []
    for src_dir in source_dirs:
        if not os.path.exists(src_dir):
            continue
        for pattern in INDEX_PATTERNS:
            for filepath in glob.glob(os.path.join(src_dir, "**", pattern), recursive=True):
                skip = False
                for sp in skip_patterns:
                    if sp in filepath:
                        skip = True
                        break
                if not skip:
                    all_files.append(filepath)

    print(f"Found {len(all_files)} files to index")

    new_count = 0
    update_count = 0
    total_chunks = 0

    for filepath in all_files:
        try:
            mtime = os.path.getmtime(filepath)
            size = os.path.getsize(filepath)
        except:
            continue

        # Check if file is unchanged
        import sqlite3 as sqlite3_mod
        db_conn = sqlite3_mod.connect(store.db_path)
        db_c = db_conn.cursor()
        db_c.execute("SELECT last_modified FROM sources WHERE file_path = ?", (filepath,))
        row = db_c.fetchone()
        db_conn.close()

        if row and abs(mtime - row[0]) < 1:
            continue  # Unchanged

        chunks = index_file(filepath, store)
        if not chunks:
            continue

        chunk_ids = store.add_chunks(chunks)

        # Build FAISS vectors
        vectors = []
        for i, (chunk_id, chunk) in enumerate(zip(chunk_ids, chunks)):
            embedding = get_embedding(chunk["content"])
            if embedding:
                vectors.append(embedding)
                # Update DB with embedding_id mapping
                store_conn = sqlite3.connect(store.db_path)
                store_c = store_conn.cursor()
                store_c.execute("UPDATE chunks SET embedding_id = ? WHERE id = ?", 
                              (chunk_id, chunk_id))
                store_conn.commit()
                store_conn.close()

        if vectors:
            vecs = np.array(vectors, dtype=np.float32)
            dim = vecs.shape[1]
            store._ensure_dim(dim)
            # Record positions before adding (current count = start position)
            start_pos = store.index.ntotal
            positions = list(range(start_pos, start_pos + len(vecs)))
            # Normalize for cosine similarity
            faiss.normalize_L2(vecs)
            store.index.add(vecs)
            # Save position mapping to DB
            store.set_embedding_positions(chunk_ids, positions)

        store.update_source(filepath, detect_category(filepath), detect_title(filepath), mtime, len(chunks))
        total_chunks += len(chunks)
        if row is None:
            new_count += 1
        else:
            update_count += 1

    store.save_faiss()
    return {"new": new_count, "updated": update_count, "total_chunks": total_chunks}


def incremental_update(store, source_dirs: List[str] = None, skip_patterns: List[str] = None):
    """
    增量更新：只处理变化的文件
    """
    if source_dirs is None:
        source_dirs = SOURCE_DIRS
    if skip_patterns is None:
        skip_patterns = SKIP_PATTERNS

    changes = store.get_changed_sources(source_dirs, skip_patterns)
    print(f"Detected {len(changes)} changes")

    new_count = 0
    update_count = 0
    delete_count = 0
    total_chunks = 0

    for change in changes:
        action = change["action"]
        filepath = change["file_path"]

        if action == "deleted":
            store.delete_chunks_by_source(filepath)
            delete_count += 1
            print(f"  [DELETE] {filepath}")
            continue

        chunks = index_file(filepath, store)
        if not chunks:
            continue

        chunk_ids = store.add_chunks(chunks)

        # Build FAISS vectors
        vectors = []
        for i, (chunk_id, chunk) in enumerate(zip(chunk_ids, chunks)):
            embedding = get_embedding(chunk["content"])
            if embedding:
                vectors.append(embedding)
                store_conn = sqlite3.connect(store.db_path)
                store_c = store_conn.cursor()
                store_c.execute("UPDATE chunks SET embedding_id = ? WHERE id = ?", 
                              (chunk_id, chunk_id))
                store_conn.commit()
                store_conn.close()

        if vectors:
            vecs = np.array(vectors, dtype=np.float32)
            faiss.normalize_L2(vecs)
            store.index.add(vecs)

        mtime = change["last_modified"]
        store.update_source(filepath, detect_category(filepath), detect_title(filepath), mtime, len(chunks))

        if action == "new":
            new_count += 1
        else:
            update_count += 1
        total_chunks += len(chunks)

    store.save_faiss()
    return {"new": new_count, "updated": update_count, "deleted": delete_count, "total_chunks": total_chunks}
