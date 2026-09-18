# -*- coding: utf-8 -*-
"""生成 v4.0 公众号封面图（900x500）"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 900, 500
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cover-v4.0.png")


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return None


def pick_font(size, bold=False):
    cands = [
        "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
    ]
    for c in cands:
        f = font(c, size)
        if f:
            return f
    return ImageFont.load_default()


img = Image.new("RGB", (W, H), "#0f2d3d")
d = ImageDraw.Draw(img)

# 渐变背景（深蓝绿 -> 青绿）
for y in range(H):
    t = y / H
    r = int(0x0f + (0x1a - 0x0f) * t)
    g = int(0x2d + (0x7f - 0x2d) * t)
    b = int(0x3d + (0x68 - 0x3d) * t)
    d.line([(0, y), (W, y)], fill=(r, g, b))

# 装饰：右上圆
d.ellipse([W - 220, -110, W + 90, 200], fill=(26, 127, 104))
d.ellipse([W - 150, -40, W + 20, 130], fill=(20, 90, 74))

# 左侧竖条
d.rectangle([60, 150, 66, 260], fill=(255, 255, 255))

# 顶部标签
f_tag = pick_font(22)
d.text((60, 92), "HERMES BUDDY  ·  v4.0 规划", font=f_tag, fill=(255, 255, 255))

# 主标题
f_title = pick_font(56, bold=True)
d.text((84, 142), "从被动应答", font=f_title, fill=(255, 255, 255))
d.text((84, 214), "到主动预判", font=f_title, fill=(255, 255, 255))

# 副标题
f_sub = pick_font(24)
d.text((62, 322), "智能预测模式：在你卡住的瞬间出现", font=f_sub, fill=(226, 240, 236))

# 底部小字
f_foot = pick_font(20)
d.text((62, 384), "事件驱动 · 本地模型 · 越用越懂你", font=f_foot, fill=(178, 214, 205))

img.save(OUT, "PNG")
print("saved:", OUT, os.path.getsize(OUT), "bytes")
