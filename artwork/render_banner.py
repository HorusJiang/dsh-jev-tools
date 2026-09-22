#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
渲染 dsh-jev-tools 的 README banner。

设计坐标以 1280x400（3.2:1）为单位书写，按 SCALE 倍输出 2560x800。
底图是 Agnes 生成的光纤爆发（`banner-bg.png`），左侧留白给文字。

**刻意不放版本号，任何版本号。** 这张图以前挂过一个版本胶囊，那意味着每次发版都要重做它；
banner 描述的是这个插件**做什么**，不是它现在是第几版——第几版由 README 徽章和 CHANGELOG 负责。
所以这个文件里也不该出现版本号字面量，包括注释：一个会过期的数字放哪儿都会过期。

**正文一律中文。** 英文 README 直接显示同一张 `docs/banner.png`，不做第二张——
两套图会各自漂移，而读者只看得见漂移后的不一致。只有包名（`dsh-jev-tools`）与品牌
专名（DeepSeek Harness、TypeSafe Jev）保持原文，它们本来就不该翻译。

中文必须走真实字体排版，并且与拉丁片段**共用一条基线**：CJK 与拉丁两套字体的
ascender 不同，逐段各画各的会让同一行的字上下跳动。这段逻辑与 `render_poster.py`
是同一套做法；两个脚本仍各自自洽，不互相 import。

用法：python artwork/render_banner.py
输出：docs/banner.png
"""

from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
BG = os.path.join(HERE, "banner-bg.png")
OUT = os.path.join(os.path.dirname(HERE), "docs", "banner.png")

SCALE = 2
W, H = 1280, 400
PAD = 64

# ---------------------------------------------------------------- palette
INK = "#FFFFFF"
DIM = "#AFC0D6"
DIMMER = "#7E93AE"
CYAN = "#4FD1E0"
AMBER = "#F0A93B"
VIOLET = "#A78BFA"
GREEN = "#4ADE80"
BGCOL = np.array([3, 7, 15], dtype=np.float64)

FONTS = {
    "ui_bold": ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf"],
    "ui": ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"],
    "ui_semibold": ["C:/Windows/Fonts/seguisb.ttf", "C:/Windows/Fonts/segoeuib.ttf"],
    "cn_bold": ["C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/simhei.ttf"],
    "cn": ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"],
    "mono": ["C:/Windows/Fonts/consola.ttf"],
    "mono_bold": ["C:/Windows/Fonts/consolab.ttf", "C:/Windows/Fonts/consola.ttf"],
}

_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def u(v: float) -> int:
    return int(round(v * SCALE))


def font(kind: str, size: float) -> ImageFont.FreeTypeFont:
    key = (kind, int(round(size)))
    if key in _cache:
        return _cache[key]
    for path in FONTS[kind]:
        if os.path.exists(path):
            try:
                f = ImageFont.truetype(path, u(size))
                _cache[key] = f
                return f
            except OSError:
                continue
    raise SystemExit(f"no usable font for {kind!r}")


def rgb_of(hexstr: str) -> tuple[int, int, int]:
    return tuple(int(hexstr[i:i + 2], 16) for i in (1, 3, 5))


# ---------------------------------------------------------------- primitives
CJK_MIN = 0x2E80  # 以下当拉丁/符号处理（·、×、— 都落在两套字体的安全区）


def runs(s: str) -> list[tuple[str, str]]:
    """把一行拆成 CJK / 拉丁 两种字体的连续片段。"""
    out: list[list[str]] = []
    for ch in s:
        k = "cn" if ord(ch) >= CJK_MIN else "lat"
        if out and out[-1][0] == k:
            out[-1][1] += ch
        else:
            out.append([k, ch])
    return [(k, v) for k, v in out]


def baseline(f: ImageFont.FreeTypeFont, top: float) -> float:
    return top + f.getmetrics()[0] / SCALE


def draw_at(d: ImageDraw.ImageDraw, x: float, top: float, s: str,
            f: ImageFont.FreeTypeFont, fill, by: float | None = None) -> float:
    """按基线绘制，返回结束 x。传 by 可让不同字号的片段共用一条基线。"""
    d.text((u(x), u(by if by is not None else baseline(f, top))), s,
           font=f, fill=fill, anchor="ls")
    return x + d.textlength(s, font=f) / SCALE


def draw_mixed(d: ImageDraw.ImageDraw, x: float, top: float, s: str,
               f_cn: ImageFont.FreeTypeFont, f_lat: ImageFont.FreeTypeFont,
               fill, by: float | None = None) -> float:
    """中英混排：共用一条基线，中文走 CJK 字体，拉丁/数字走拉丁字体。"""
    base_y = by if by is not None else baseline(f_cn, top)
    cx = x
    for kind, seg in runs(s):
        f = f_cn if kind == "cn" else f_lat
        d.text((u(cx), u(base_y)), seg, font=f, fill=fill, anchor="ls")
        cx += d.textlength(seg, font=f) / SCALE
    return cx


def width_of(d: ImageDraw.ImageDraw, s: str,
             f_cn: ImageFont.FreeTypeFont,
             f_lat: ImageFont.FreeTypeFont | None = None) -> float:
    total = 0.0
    for kind, seg in runs(s):
        f = f_cn if (kind == "cn" or f_lat is None) else f_lat
        total += d.textlength(seg, font=f) / SCALE
    return total


def draw_spaced(d: ImageDraw.ImageDraw, x: float, y: float, s: str,
                f: ImageFont.FreeTypeFont, fill, tracking: float) -> float:
    by = baseline(f, y)
    cx = x
    for ch in s:
        d.text((u(cx), u(by)), ch, font=f, fill=fill, anchor="ls")
        cx += d.textlength(ch, font=f) / SCALE + tracking
    return cx


def glow(layer: Image.Image, radius: float, gain: float = 1.0) -> Image.Image:
    g = layer.filter(ImageFilter.GaussianBlur(u(radius)))
    if gain != 1.0:
        a = g.split()[3].point(lambda v: min(255, int(v * gain)))
        g.putalpha(a)
    return g


def rrect_mask(w: int, h: int, radius: float) -> Image.Image:
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w - 1, h - 1), radius=u(radius), fill=255)
    return m


def paste_rrect(base: Image.Image, box, radius: float, fill) -> None:
    """Semi-transparent rounded rect. `paste(fill)` ignores the fill's alpha; this does not."""
    bw, bh = u(box[2] - box[0]), u(box[3] - box[1])
    m = rrect_mask(bw, bh, radius)
    a = m.point(lambda v: v * fill[3] // 255)
    layer = Image.new("RGBA", (bw, bh), tuple(fill[:3]) + (0,))
    layer.putalpha(a)
    base.alpha_composite(layer, (u(box[0]), u(box[1])))


# ---------------------------------------------------------------- background
def build_background() -> Image.Image:
    art = Image.open(BG).convert("RGB")
    # Cover 2560x800 from a 2.33:1 source: scale to the target width, then crop
    # the height with a slight upward bias so the burst keeps its crown.
    target_w, target_h = W * SCALE, H * SCALE
    scaled_h = round(art.height * target_w / art.width)
    art = art.resize((target_w, scaled_h), Image.LANCZOS)
    top = round((scaled_h - target_h) * 0.42)
    art = art.crop((0, top, target_w, top + target_h))

    arr = np.asarray(art, dtype=np.float64)
    h, w = arr.shape[:2]
    xx = np.arange(w) / w

    # Horizontal scrim: the left third has to stay quiet enough for white type,
    # the right stays close to untouched so the burst still reads.
    #
    # Smoothstep rather than a piecewise-linear ramp on purpose — a ramp that
    # steepens where the source art already darkens draws a visible vertical
    # band right at the join, which the first version of this banner had.
    t = np.clip((xx - 0.02) / 0.66, 0.0, 1.0)
    ease = t * t * (3.0 - 2.0 * t)
    alpha = (0.92 * (1.0 - ease) + 0.05 * ease)[None, :].repeat(h, axis=0)

    # A light vertical vignette so the frame has edges.
    yy = np.arange(h) / h
    edge = np.clip((yy - 0.86) / 0.14, 0.0, 1.0) * 0.35
    alpha = np.clip(alpha + edge[:, None], 0.0, 1.0)

    out = arr * (1.0 - alpha[..., None]) + BGCOL[None, None, :] * alpha[..., None]
    # Very slight overall lift so the plate does not read as flat black.
    out = np.clip(out * 1.02, 0, 255)
    return Image.fromarray(out.astype(np.uint8), "RGB").convert("RGBA")


def draw_topbar(img: Image.Image) -> None:
    bar = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(bar)
    stops = [(0.00, (79, 209, 224)), (0.30, (106, 168, 255)),
             (0.62, (167, 139, 250)), (1.00, (240, 169, 59))]
    for x in range(u(W)):
        f = x / (u(W) - 1)
        col = stops[-1][1]
        for i in range(len(stops) - 1):
            a, ca = stops[i]
            b, cb = stops[i + 1]
            if a <= f <= b:
                t = (f - a) / (b - a)
                col = tuple(int(ca[k] + (cb[k] - ca[k]) * t) for k in range(3))
                break
        d.line([(x, 0), (x, u(3))], fill=col + (255,))
    img.alpha_composite(glow(bar, 9, 0.85))
    img.alpha_composite(bar)


# ---------------------------------------------------------------- content
def draw_content(img: Image.Image) -> None:
    f_eyebrow = font("mono_bold", 15)
    f_title = font("ui_bold", 68)
    f_lede = font("cn_bold", 30)
    f_tag = font("cn", 21)
    f_pill = font("cn", 15)
    f_foot = font("cn", 13)

    d = ImageDraw.Draw(img)

    # ---- eyebrow（品牌专名，保持原文）
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw_spaced(ImageDraw.Draw(layer), PAD, 44, "DEEPSEEK HARNESS × TYPESAFE JEV",
                f_eyebrow, CYAN, 4.2)
    img.alpha_composite(glow(layer, 8, 0.9))
    img.alpha_composite(layer)
    d = ImageDraw.Draw(img)

    # ---- title（包名，不可翻译；无版本号：那是徽章与 CHANGELOG 的职责）
    y_title = 66
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).text((u(PAD), u(baseline(f_title, y_title))), "dsh-jev-tools",
                               font=f_title, fill=INK, anchor="ls")
    img.alpha_composite(glow(layer, 16, 0.42))
    img.alpha_composite(layer)
    d = ImageDraw.Draw(img)

    # ---- lede：banner 得自己回答「它是什么」。
    # 口号回答不了这个问题（"判定，而非生成" 是性质，不是身份），所以这一行放
    # 预诊台那句类比，并用暖色把它拎出来——三段共用一条基线，否则中文与拉丁
    # 两套 ascender 会让这一行自己错位。
    y_lede = 170
    by_lede = baseline(f_lede, y_lede)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    x = draw_at(ld, PAD, y_lede, "它是", f_lede, "#C7D6EA", by=by_lede)
    x = draw_at(ld, x, y_lede, "大模型的预诊台", f_lede, AMBER, by=by_lede)
    draw_at(ld, x, y_lede, "：只分诊，不诊断", f_lede, "#8FA3BE", by=by_lede)
    img.alpha_composite(glow(layer, 11, 0.5))
    img.alpha_composite(layer)
    d = ImageDraw.Draw(img)

    # ---- tagline
    draw_at(d, PAD, 216, "不生成文本，也不替代主模型——只在关键节点插一次判定",
            f_tag, DIM)

    # ---- capability pills（与海报的四张卡片同名，两处不能各说各的）
    y_pill, pill_h, gap = 258, 34, 14
    cx = PAD
    for label, accent in (("精简输出", CYAN), ("注入筛查", AMBER),
                          ("技能推荐", VIOLET), ("交付闸门", GREEN)):
        tw = width_of(d, label, f_pill)
        pw = tw + 34
        box = (cx, y_pill, cx + pw, y_pill + pill_h)
        rgb = rgb_of(accent)
        paste_rrect(img, box, pill_h / 2, rgb + (30,))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle(tuple(u(v) for v in box), radius=u(pill_h / 2),
                            outline=rgb + (140,), width=max(1, u(0.9)))
        draw_at(d, cx + 17, y_pill + 8, label, f_pill, accent)
        cx += pw + gap

    # ---- footer（两行不变，是这套设计的"性质"清单）
    draw_at(d, PAD, 330, "带类型的问题 · 返回概率 · 无需解析 · 一次请求", f_foot, DIMMER)
    draw_at(d, PAD, 352, "无 key 完全惰性 · 绝不阻挡步骤 · 每次判定都记账", f_foot, DIMMER)


def main() -> None:
    img = build_background()
    draw_topbar(img)
    draw_content(img)
    img.convert("RGB").save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT}  {img.width}x{img.height}  {os.path.getsize(OUT)} bytes")


if __name__ == "__main__":
    sys.exit(main())
