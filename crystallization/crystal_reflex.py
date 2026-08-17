#!/usr/bin/env python3
"""
Crystal Reflex Model - Qwen3-0.6B 微调反射模型推理服务

部署在 231 上，CPU 推理，作为具身智能三层反射的意图分类层。
端口 9124。

用法:
  python3 /opt/crystal-reflex/crystal_reflex.py --serve  # 启动 HTTP 服务
  python3 /opt/crystal-reflex/crystal_reflex.py --test   # 运行测试
"""

import argparse
import json
import os
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

# Model path: configurable via env var, fallback to default
# Supports both fine-tuned model and original Qwen3-0.6B from ModelScope
MODEL_PATH = os.environ.get("CRYSTAL_MODEL_PATH", "/opt/crystal-model/qwen3-06b-deploy")
# If fine-tuned model not found, fallback to downloading Qwen3-0.6B from ModelScope
FALLBACK_MODEL = "Qwen/Qwen3-0.6B"

_model = None
_tokenizer = None

INTENT_MAP = {
    "重启": "L0_builtin",
    "时间": "L0_builtin",
    "几点": "L0_builtin",
    "问候": "L0_builtin",
    "你好": "L0_builtin",
    "名字": "L0_builtin",
    "配置": "L1_code",
    "上传": "L1_code",
    "草稿": "L1_code",
    "cron": "L1_code",
    "key": "L1_code",
    "embedding": "L1_code",
    "查询": "L2_search",
    "日志": "L2_search",
    "分析": "L3_llm",
    "对比": "L3_llm",
    "评估": "L3_llm",
}


def load_model():
    global _model, _tokenizer
    if _model is None:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        import torch
        
        model_path = MODEL_PATH
        if not os.path.exists(model_path):
            print(f"Fine-tuned model not found at {model_path}")
            print(f"Falling back to {FALLBACK_MODEL} (will download from ModelScope/HuggingFace)")
            print(f"To use a fine-tuned model, set CRYSTAL_MODEL_PATH env var")
            model_path = FALLBACK_MODEL
        
        print(f"Loading model from {model_path}...")
        t0 = time.time()
        _tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        _model = AutoModelForCausalLM.from_pretrained(
            model_path,
            torch_dtype=torch.bfloat16,
            trust_remote_code=True,
        )
        _model.eval()
        print(f"Model loaded in {time.time()-t0:.1f}s")


def classify_intent(prompt):
    """快速意图分类 - 只生成 4 tokens"""
    import torch
    load_model()
    
    messages = [{"role": "user", "content": prompt}]
    text = _tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True,
        enable_thinking=False
    )
    inputs = _tokenizer(text, return_tensors="pt")
    
    t0 = time.time()
    with torch.no_grad():
        outputs = _model.generate(
            **inputs,
            max_new_tokens=4,
            do_sample=False,
            pad_token_id=_tokenizer.pad_token_id or _tokenizer.eos_token_id,
        )
    latency = time.time() - t0
    
    prefix = _tokenizer.decode(
        outputs[0][inputs["input_ids"].shape[1]:],
        skip_special_tokens=True
    )
    
    intent = "L3_llm"
    for keyword, layer in INTENT_MAP.items():
        if keyword in prompt.lower():
            intent = layer
            break
    
    return {
        "prefix": prefix.strip(),
        "intent": intent,
        "latency_ms": round(latency * 1000),
    }


def generate_full(prompt, max_new_tokens=64):
    """完整生成"""
    import torch
    load_model()
    
    messages = [{"role": "user", "content": prompt}]
    text = _tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True,
        enable_thinking=False
    )
    inputs = _tokenizer(text, return_tensors="pt")
    
    t0 = time.time()
    with torch.no_grad():
        outputs = _model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            pad_token_id=_tokenizer.pad_token_id or _tokenizer.eos_token_id,
        )
    latency = time.time() - t0
    response = _tokenizer.decode(
        outputs[0][inputs["input_ids"].shape[1]:],
        skip_special_tokens=True
    )
    return response, latency


class ReflexHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers["Content-Length"])
        body = self.rfile.read(content_length)
        data = json.loads(body)
        prompt = data.get("prompt", "")
        mode = data.get("mode", "classify")
        
        try:
            if mode == "classify":
                result = classify_intent(prompt)
            else:
                response, latency = generate_full(
                    prompt,
                    max_new_tokens=data.get("max_tokens", 64)
                )
                result = {
                    "response": response,
                    "latency_ms": round(latency * 1000),
                }
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result, ensure_ascii=False).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
    
    def log_message(self, format, *args):
        pass


def run_test():
    test_cases = [
        ("帮我重启一下服务", "L0_builtin"),
        ("现在几点了", "L0_builtin"),
        ("API key 不行了怎么办", "L1_code"),
        ("微信公众号草稿上传失败了", "L1_code"),
        ("知识库怎么配置 embedding", "L1_code"),
        ("配置一下 cron job", "L1_code"),
        ("你叫什么名字", "L0_builtin"),
        ("帮我查一下日志", "L2_search"),
        ("分析一下最近的系统性能趋势", "L3_llm"),
        ("对比一下 LoRA 和全参数微调的优劣", "L3_llm"),
    ]
    
    print("=" * 60)
    print("Crystal Reflex Model - 意图分类测试")
    print(f"Model: Qwen3-0.6B (fine-tuned)")
    print("=" * 60)
    
    load_model()
    
    total_latency = 0
    correct = 0
    for i, (prompt, expected) in enumerate(test_cases, 1):
        result = classify_intent(prompt)
        total_latency += result["latency_ms"]
        ok = result["intent"] == expected
        if ok:
            correct += 1
        print(f"\n[{i}] Q: {prompt}")
        print(f"    前缀: {result['prefix'][:50]}")
        print(f"    意图: {result['intent']} (期望: {expected}) {'✅' if ok else '❌'}")
        print(f"    ⏱ {result['latency_ms']}ms")
    
    avg = total_latency / len(test_cases)
    print(f"\n{'=' * 60}")
    print(f"平均延迟: {avg:.0f}ms")
    print(f"准确率: {correct}/{len(test_cases)}")


def serve(port=9124):
    print(f"Crystal Reflex Service starting on 0.0.0.0:{port}")
    load_model()
    server = HTTPServer(("0.0.0.0", port), ReflexHandler)
    print(f"Listening on :{port}")
    server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--port", type=int, default=9124)
    args = parser.parse_args()
    
    if args.test:
        run_test()
    elif args.serve:
        serve(args.port)
    else:
        parser.print_help()
