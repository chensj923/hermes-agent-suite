"""
知识库配置 - 本地模型版 (CPU)
"""
import os

# Local embedding model (bge-base-zh-v1.5, 768-dim, matches FAISS index)
LOCAL_EMBEDDING_PATH = os.environ.get(
    "KB_EMBED_MODEL_PATH",
    os.path.expanduser("~/.cache/modelscope/BAAI/bge-base-zh-v1___5")
)

# Local reranker model (bge-reranker-v2-m3)
LOCAL_RERANKER_PATH = os.environ.get(
    "KB_RERANKER_MODEL_PATH",
    os.path.expanduser("~/.cache/modelscope/BAAI/bge-reranker-v2-m3")
)

# LM Studio settings (kept for backward compat with scripts that import these names)
LM_STUDIO_URL = ""
LM_STUDIO_API_KEY = ""
EMBEDDING_MODEL = "bge-base-zh-v1.5"
RERANK_MODEL = "bge-reranker-v2-m3"
RERANK_API_KEY = ""
RERANK_URL = ""

# Data directory
KB_DATA_DIR = os.path.join(os.path.expanduser("~/.hermes"), "knowledge-base", "kb_data")
DB_PATH = os.path.join(KB_DATA_DIR, "knowledge.db")
FAISS_PATH = os.path.join(KB_DATA_DIR, "vectors.faiss")

# Default search params
DEFAULT_TOP_K = 10
DEFAULT_RERANK_TOP_K = 5

# Indexed source directories (will be scanned for new/changed files)
SOURCE_DIRS = [
    os.path.expanduser("~/.hermes/skills"),
    os.path.expanduser("~/.hermes/memories"),
    os.path.expanduser("~/.hermes/scripts"),
    os.path.expanduser("~/.hermes/plugins"),
]

# File patterns to index
INDEX_PATTERNS = ["*.md", "*.py", "*.yaml", "*.yml", "*.json", "*.txt"]

# Skip patterns
SKIP_PATTERNS = [".git/", "__pycache__", ".bundled_", ".usage.json", ".lock"]

# Chunk size for text splitting
CHUNK_SIZE = 512  # tokens approx
CHUNK_OVERLAP = 64
