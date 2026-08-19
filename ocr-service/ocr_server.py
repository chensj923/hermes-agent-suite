#!/usr/bin/env python3
"""
Image Understanding Service — Ollama (MiniCPM-V) + PaddleOCR
当模型无视觉能力时，用此服务解读图片。

能力：
  1. 图片描述（MiniCPM-V）— 生成自然语言描述：场景、物体、人物、动作、颜色
  2. 视觉问答 VQA — 针对图片提问，如"图里有几个人"、"表格数据是什么"
  3. 文字提取（PaddleOCR）— 精确提取图片中的文字，中英文混合
  4. 综合分析 — 描述 + 文字 合并，一键获取全部信息

Endpoints:
  POST /describe          — 上传图片，返回自然语言描述
  POST /describe/url      — 传图片 URL，返回描述
  POST /vqa               — 上传图片+问题，AI 回答
  POST /ocr               — 上传图片，PaddleOCR 提取文字
  POST /ocr/url           — 传图片 URL，提取文字
  POST /analyze           — 上传图片，综合分析（描述+文字）
  POST /analyze/url       — 传图片 URL，综合分析
  POST /analyze/base64    — 传 base64 图片，综合分析
  GET  /health            — 健康检查

Usage:
  curl -X POST http://localhost:9121/describe -F "file=@photo.jpg"
  curl -X POST http://localhost:9121/vqa -F "file=@photo.jpg" -F "question=图里有几个人？"
  curl -X POST http://localhost:9121/analyze -F "file=@screenshot.png"
"""

import io
import os
import base64
import logging
import urllib.request
import json
import httpx

import uvicorn
from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.responses import JSONResponse
from PIL import Image

# ── config ──
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
VISION_MODEL = os.environ.get("VISION_MODEL", "minicpm-v")
FAST_MODEL = os.environ.get("FAST_MODEL", "moondream")
PORT = int(os.environ.get("IMG_PORT", "9121"))
HOST = os.environ.get("IMG_HOST", "0.0.0.0")

# ── logging ──
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("img-service")

app = FastAPI(title="Image Understanding Service", version="3.0")

# ── PaddleOCR lazy init ──
_ocr_engine = None


def get_ocr():
    global _ocr_engine
    if _ocr_engine is None:
        log.info("Initializing RapidOCR (ONNX)...")
        from rapidocr_onnxruntime import RapidOCR
        _ocr_engine = RapidOCR()
        log.info("RapidOCR ready.")
    return _ocr_engine


# ── Ollama vision ──

async def ollama_vision(image_b64: str, prompt: str, timeout: float = 600, model: str = None) -> str:
    """调用 Ollama 多模态模型，传入 base64 图片 + 文字 prompt，返回回答。"""
    use_model = model or VISION_MODEL
    payload = {
        "model": use_model,
        "messages": [
            {"role": "user", "content": prompt, "images": [image_b64]}
        ],
        "stream": False,
        "options": {"temperature": 0.3, "num_ctx": 4096},
        "keep_alive": "30m",  # 模型常驻内存 30 分钟
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(f"{OLLAMA_HOST}/api/chat", json=payload)
        resp.raise_for_status()
        data = resp.json()
        return data.get("message", {}).get("content", "").strip()


async def ollama_vision_stream(image_b64: str, prompt: str, timeout: float = 600) -> str:
    """流式调用（暂不用，保留接口）。"""
    payload = {
        "model": VISION_MODEL,
        "messages": [{"role": "user", "content": prompt, "images": [image_b64]}],
        "stream": True,
        "options": {"temperature": 0.3, "num_ctx": 4096},
    }
    full = ""
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", f"{OLLAMA_HOST}/api/chat", json=payload) as resp:
            async for line in resp.aiter_lines():
                if not line:
                    continue
                chunk = json.loads(line)
                content = chunk.get("message", {}).get("content", "")
                full += content
                if chunk.get("done"):
                    break
    return full.strip()


# ── PaddleOCR ──

def ocr_image(img: Image.Image) -> dict:
    engine = get_ocr()
    import numpy as np
    img_array = np.array(img.convert("RGB"))
    result, elapse = engine(img_array)
    texts, confidences = [], []
    if result:
        for line in result:
            # RapidOCR format: [box, text, confidence]
            text = line[1]
            conf = float(line[2])
            texts.append(text)
            confidences.append(round(conf, 4))
    return {"text": "\n".join(texts), "lines": texts, "count": len(texts), "confidences": confidences}


# ── image helpers ──

def img_to_b64(img: Image.Image, max_width: int = 512) -> str:
    """转 base64，大图自动缩小到 max_width 宽度，压缩后做锐化+对比度增强。"""
    w, h = img.size
    if w > max_width:
        ratio = max_width / w
        img = img.resize((max_width, int(h * ratio)), Image.LANCZOS)
    # 压缩后处理：锐化 + 轻微对比度增强，补偿缩放带来的细节损失
    from PIL import ImageEnhance, ImageFilter
    img = img.filter(ImageFilter.UnsharpMask(radius=1, percent=120, threshold=3))
    enhancer = ImageEnhance.Contrast(img)
    img = enhancer.enhance(1.1)
    # JPEG 不支持 alpha 通道：RGBA/P/LA 先合成到白底再转 RGB
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode()


async def load_from_upload(file: UploadFile) -> Image.Image:
    content = await file.read()
    return Image.open(io.BytesIO(content))


def load_from_url(url: str) -> Image.Image:
    req = urllib.request.Request(url, headers={"User-Agent": "IMG-Service/3.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return Image.open(io.BytesIO(resp.read()))


# ── endpoints: describe ──

DESCRIBE_PROMPT = (
    "Describe this image in complete detail. "
    "Cover: 1) Overall scene and setting 2) All visible objects and their positions "
    "3) Any text visible in the image 4) Colors and lighting 5) People and their actions "
    "6) If it is a screenshot or interface, describe the UI elements and layout "
    "7) Any notable details that might be important. "
    "Be thorough and do not omit details."
)

@app.post("/describe")
async def describe_file(file: UploadFile = File(...), model: str = Form(None)):
    try:
        img = await load_from_upload(file)
    except Exception as e:
        raise HTTPException(400, f"无法读取图片: {e}")
    log.info(f"Describe: file={file.filename}, size={img.size}, model={model or VISION_MODEL}")
    b64 = img_to_b64(img)
    desc = await ollama_vision(b64, DESCRIBE_PROMPT, model=model)
    return {"description": desc, "filename": file.filename, "model": model or VISION_MODEL}


@app.post("/describe/url")
async def describe_url(url: str = Form(...)):
    try:
        img = load_from_url(url)
    except Exception as e:
        raise HTTPException(400, f"下载图片失败: {e}")
    b64 = img_to_b64(img)
    desc = await ollama_vision(b64, DESCRIBE_PROMPT)
    return {"description": desc, "url": url}


# ── endpoints: vqa ──

@app.post("/vqa")
async def vqa_file(
    file: UploadFile = File(...),
    question: str = Form(...),
    model: str = Form(None),
):
    try:
        img = await load_from_upload(file)
    except Exception as e:
        raise HTTPException(400, f"无法读取图片: {e}")
    log.info(f"VQA: file={file.filename}, q={question}, model={model or VISION_MODEL}")
    b64 = img_to_b64(img)
    prompt = f"Look at this image carefully and answer the question. Question: {question}\nRespond in Chinese if possible, otherwise in English."
    answer = await ollama_vision(b64, prompt, model=model)
    return {"question": question, "answer": answer, "filename": file.filename, "model": model or VISION_MODEL}


# ── endpoints: ocr ──

@app.post("/ocr")
async def ocr_file(file: UploadFile = File(...)):
    try:
        img = await load_from_upload(file)
    except Exception as e:
        raise HTTPException(400, f"无法读取图片: {e}")
    log.info(f"OCR: file={file.filename}, size={img.size}")
    result = ocr_image(img)
    result["filename"] = file.filename
    return JSONResponse(content=result)


@app.post("/ocr/url")
async def ocr_url(url: str = Form(...)):
    try:
        img = load_from_url(url)
    except Exception as e:
        raise HTTPException(400, f"下载图片失败: {e}")
    result = ocr_image(img)
    result["url"] = url
    return JSONResponse(content=result)


# ── endpoints: analyze (combined) ──

ANALYZE_PROMPT = (
    "Analyze this image thoroughly:\n"
    "1. Describe the content (scene, objects, people, colors, layout)\n"
    "2. If there is text in the image, transcribe it exactly\n"
    "3. If it's a screenshot/document/table, describe the structure and key information\n"
    "4. If it's a photo, describe the scene and atmosphere\n"
    "Respond in Chinese if possible, otherwise in English."
)

@app.post("/analyze")
async def analyze_file(file: UploadFile = File(...), model: str = Form(None)):
    try:
        img = await load_from_upload(file)
    except Exception as e:
        raise HTTPException(400, f"无法读取图片: {e}")
    log.info(f"Analyze: file={file.filename}, size={img.size}, model={model or VISION_MODEL}")
    b64 = img_to_b64(img)

    # 并行：Ollama 描述 + PaddleOCR 文字
    import asyncio
    desc_task = asyncio.create_task(ollama_vision(b64, ANALYZE_PROMPT, model=model))
    
    ocr_result = {"text": "", "lines": [], "count": 0, "confidences": []}
    try:
        ocr_result = ocr_image(img)
    except Exception as e:
        log.warning(f"OCR skipped: {e}")

    description = await desc_task

    return {
        "description": description,
        "ocr_text": ocr_result["text"],
        "ocr_lines": ocr_result["lines"],
        "ocr_count": ocr_result["count"],
        "filename": file.filename,
        "model": model or VISION_MODEL,
    }


@app.post("/analyze/url")
async def analyze_url(url: str = Form(...)):
    try:
        img = load_from_url(url)
    except Exception as e:
        raise HTTPException(400, f"下载图片失败: {e}")
    b64 = img_to_b64(img)
    desc = await ollama_vision(b64, ANALYZE_PROMPT)
    ocr_result = {"text": "", "lines": [], "count": 0}
    try:
        ocr_result = ocr_image(img)
    except Exception as e:
        log.warning(f"OCR skipped: {e}")
    return {"description": desc, **ocr_result, "url": url}


@app.post("/analyze/base64")
async def analyze_base64(data: dict):
    """传 base64 图片做综合分析。Body: {"image": "base64_string", "question": "可选问题"}"""
    b64_raw = data.get("image", "")
    if not b64_raw:
        raise HTTPException(400, "缺少 image 字段")
    if "," in b64_raw and b64_raw.startswith("data:"):
        b64_raw = b64_raw.split(",", 1)[1]

    question = data.get("question")
    try:
        content = base64.b64decode(b64_raw)
        img = Image.open(io.BytesIO(content))
    except Exception as e:
        raise HTTPException(400, f"解码失败: {e}")

    b64 = img_to_b64(img)
    prompt = f"问题：{question}\n用中文回答。" if question else ANALYZE_PROMPT
    desc = await ollama_vision(b64, prompt)
    return {"description": desc, "question": question}


# ── smart: OCR 秒出 + 视觉描述(带超时降级) ──

@app.post("/smart")
async def smart_analyze(file: UploadFile = File(...), model: str = Form(None)):
    """智能分析：OCR 立即返回，视觉描述设 90s 超时，超时则只返回 OCR。"""
    import asyncio
    try:
        img = await load_from_upload(file)
    except Exception as e:
        raise HTTPException(400, f"无法读取图片: {e}")
    log.info(f"Smart: file={file.filename}, size={img.size}, model={model or FAST_MODEL}")

    # 1. OCR 立即执行（秒级）
    ocr_result = {"text": "", "lines": [], "count": 0, "confidences": []}
    try:
        ocr_result = ocr_image(img)
    except Exception as e:
        log.warning(f"OCR failed: {e}")

    # 2. 视觉描述，600s 超时降级（CPU 推理慢，给足时间拿完整结果）
    b64 = img_to_b64(img)
    # /smart 默认用强模型 minicpm-v（VISION_MODEL）而非 moondream。
    # moondream 只能给粗糙描述，无法判断朝向/畸形/部件细节；minicpm-v 本地推理慢几秒但准确。
    use_model = model or VISION_MODEL
    description = ""
    vision_ok = False
    try:
        desc_task = asyncio.create_task(ollama_vision(b64, DESCRIBE_PROMPT, model=use_model, timeout=600))
        description = await asyncio.wait_for(desc_task, timeout=600)
        vision_ok = True
    except asyncio.TimeoutError:
        log.warning(f"Vision timed out after 600s, returning OCR only")
        description = "[视觉描述超时，仅返回 OCR 结果]"
    except Exception as e:
        log.warning(f"Vision failed: {e}")
        description = f"[视觉描述失败: {e}]"

    return {
        "description": description,
        "ocr_text": ocr_result["text"],
        "ocr_lines": ocr_result["lines"],
        "ocr_count": ocr_result["count"],
        "vision_ok": vision_ok,
        "filename": file.filename,
        "model": use_model,
    }


# ── health ──

@app.get("/health")
async def health():
    # 检查 Ollama 连通性
    ollama_ok = False
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{OLLAMA_HOST}/api/tags")
            ollama_ok = resp.status_code == 200
    except:
        pass
    return {
        "status": "ok",
        "ollama": ollama_ok,
        "vision_model": VISION_MODEL,
        "fast_model": FAST_MODEL,
        "ocr_loaded": _ocr_engine is not None,
    }


if __name__ == "__main__":
    log.info(f"Starting Image Understanding Service on {HOST}:{PORT}")
    log.info(f"Ollama: {OLLAMA_HOST}, Fast model: {FAST_MODEL}, Vision model: {VISION_MODEL}")
    # 启动时卸载所有模型，避免内存竞争
    try:
        import httpx as _hx
        with _hx.Client(timeout=10) as c:
            c.post(f"{OLLAMA_HOST}/api/generate", json={"model": "minicpm-v", "keep_alive": 0})
            log.info("Unloaded minicpm-v to free memory for fast model")
    except:
        pass
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
