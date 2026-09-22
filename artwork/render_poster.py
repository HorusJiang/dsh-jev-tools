#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
渲染 dsh-jev-tools 朋友圈宣传海报。

设计坐标全部以 1080x1440（3:4）为单位书写，最后按 SCALE 倍渲染，
避免手算 2x 像素。中文一律用系统字体真实排版，绝不交给图片模型生成。

排版两条硬规则：
  1. 半透明色块必须走 alpha_composite，不能走 paste(fill) —— 后者会无视 fill 的 alpha。
  2. 所有文字按「基线」对齐；混排中英文时共用一个基线，否则两套字体的
     ascender 不同会让同一行的字上下跳动。

用法：python artwork/render_poster.py
输出：artwork/dsh-jev-tools-poster.png
"""

from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
BG = os.path.join(HERE, "bg.png")
OUT = os.path.join(HERE, "dsh-jev-tools-poster.png")

SCALE = 2
W, H = 1080, 1440
PAD = 72
CONTENT_W = W - PAD * 2  # 936

# ---------------------------------------------------------------- palette
INK = "#F2F7FF"
DIM = "#A7B8CF"
DIM2 = "#7E93AE"
CYAN = "#4FD1E0"
AMBER = "#F0A93B"
VIOLET = "#A78BFA"
GREEN = "#4ADE80"
GREY = "#9AAEC6"
BGCOL = np.array([3, 7, 15], dtype=np.float64)

FONTS = {
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
CJK_MIN = 0x2E80  # 以下当拉丁/符号处理（·、→、≥、★ 都落在两套字体的安全区）


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
               fill) -> float:
    """中英混排：共用一条基线，中文走 CJK 字体，拉丁/数字走等宽字体。"""
    by = baseline(f_cn, top)
    cx = x
    for kind, seg in runs(s):
        f = f_cn if kind == "cn" else f_lat
        d.text((u(cx), u(by)), seg, font=f, fill=fill, anchor="ls")
        cx += d.textlength(seg, font=f) / SCALE
    return cx


def width_of(d: ImageDraw.ImageDraw, s: str,
             f_cn: ImageFont.FreeTypeFont, f_lat: ImageFont.FreeTypeFont | None = None) -> float:
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
    """半透明圆角矩形。fill 的 alpha 必须真的生效，所以走 alpha_composite。"""
    bw, bh = u(box[2] - box[0]), u(box[3] - box[1])
    m = rrect_mask(bw, bh, radius)
    a = m.point(lambda v: v * fill[3] // 255)
    layer = Image.new("RGBA", (bw, bh), tuple(fill[:3]) + (0,))
    layer.putalpha(a)
    base.alpha_composite(layer, (u(box[0]), u(box[1])))


def panel(img: Image.Image, box, radius: float, fill, border) -> ImageDraw.ImageDraw:
    paste_rrect(img, box, radius, fill)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(tuple(u(v) for v in box), radius=u(radius),
                        outline=border, width=max(1, u(1)))
    return d


# ---------------------------------------------------------------- background
def build_background() -> Image.Image:
    art = Image.open(BG).convert("RGB").resize((W * SCALE, H * SCALE), Image.LANCZOS)
    arr = np.asarray(art, dtype=np.float64)
    # 提亮中间调，让 Agnes 那束光纤的光真正透出来（纯黑处仍保持黑）
    arr = 255.0 * np.power(np.clip(arr, 0, 255) / 255.0, 0.86)

    h, w = arr.shape[:2]
    yy = np.arange(h) / h

    # 纵向压暗：上半压死保证大标题干净，中下刻意留亮让光核与光带透出
    stops_y = [0.00, 0.12, 0.22, 0.38, 0.50, 0.62, 0.74, 0.86, 0.94, 1.00]
    stops_a = [0.92, 0.86, 0.64, 0.34, 0.20, 0.17, 0.30, 0.52, 0.74, 0.88]
    alpha = np.interp(yy, stops_y, stops_a)

    # 左上再压一层径向暗角，保证大标题区绝对干净
    X, Y = np.meshgrid(np.arange(w) / w, np.arange(h) / h)
    dist = np.sqrt(((X - 0.10) / 0.95) ** 2 + ((Y - 0.05) / 0.85) ** 2)
    alpha = np.clip(alpha[:, None] + np.clip(1.0 - dist, 0.0, 1.0) * 0.55, 0.0, 1.0)

    out = arr * (1.0 - alpha[..., None]) + BGCOL[None, None, :] * alpha[..., None]

    # 极淡扫描线，只在暗部留质感
    scan = (np.arange(h) % (2 * SCALE) < SCALE).astype(np.float64) * 0.012
    out = out * (1.0 - scan[:, None, None])

    # 顶部染一点冷色，呼应渐变条
    tint = np.array([79.0, 209.0, 224.0])
    ramp = (1.0 - yy)[:, None, None] * 0.030
    out = out * (1.0 - ramp) + tint[None, None, :] * ramp

    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB").convert("RGBA")


def draw_topbar(img: Image.Image) -> None:
    bar = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(bar)
    stops = [(0.00, (79, 209, 224)), (0.34, (106, 168, 255)),
             (0.66, (167, 139, 250)), (1.00, (240, 169, 59))]
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
        d.line([(x, 0), (x, u(6))], fill=col + (255,))
    img.alpha_composite(glow(bar, 18, 0.9))
    img.alpha_composite(bar)


def glass_card(img: Image.Image, blurred: Image.Image, x, y, w, h, radius, accent) -> None:
    bw, bh = u(w), u(h)
    mask = rrect_mask(bw, bh, radius)

    # 磨砂：把底图的模糊版本按圆角贴回来，形成真实玻璃感
    region = blurred.crop((u(x), u(y), u(x + w), u(y + h)))
    img.paste(region, (u(x), u(y)), mask)

    # 玻璃本身压一层暗色，保证卡片无论压在多亮的光斑上都读得清
    dark = Image.new("RGBA", (bw, bh), (4, 8, 16, 0))
    dark.putalpha(mask.point(lambda v: v * 118 // 255))
    img.alpha_composite(dark, (u(x), u(y)))

    # 再叠一层极淡的白色渐变提亮（顶部略亮）
    ramp = Image.new("L", (1, bh))
    for i in range(bh):
        t = i / max(1, bh - 1)
        ramp.putpixel((0, i), int(20 - 12 * t))
    tint = Image.new("RGBA", (bw, bh), (255, 255, 255, 0))
    tint.putalpha(ImageChops.multiply(ramp.resize((bw, bh)), mask))
    img.alpha_composite(tint, (u(x), u(y)))

    d = ImageDraw.Draw(img)
    d.rounded_rectangle((u(x), u(y), u(x + w), u(y + h)), radius=u(radius),
                        outline=(255, 255, 255, 34), width=max(1, u(0.75)))
    d.line([(u(x + radius), u(y + 0.6)), (u(x + w - radius), u(y + 0.6))],
           fill=(255, 255, 255, 46), width=max(1, u(0.75)))

    # 左侧强调色竖条 + 光晕
    bar = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(bar).rounded_rectangle(
        (u(x), u(y), u(x + 3.5), u(y + h)), radius=u(1.75), fill=tuple(accent) + (255,))
    img.alpha_composite(glow(bar, 10, 1.2))
    img.alpha_composite(bar)


# ---------------------------------------------------------------- content
def draw_content(img: Image.Image) -> None:
    f_eyebrow = font("mono_bold", 21)
    f_h1 = font("cn_bold", 82)
    f_sub = font("cn", 25)
    f_sub_b = font("cn_bold", 25)
    f_brand = font("cn_bold", 40)
    f_pill = font("mono_bold", 20)
    f_tag = font("cn", 25)
    f_card_h = font("cn_bold", 27)
    f_badge = font("mono_bold", 20)
    f_card_p = font("cn", 21)
    f_metric = font("cn_bold", 20)
    f_metric_m = font("mono_bold", 19)
    f_blk_t = font("cn", 20)
    f_blk_h = font("cn_bold", 20)
    f_blk_b = font("cn", 20)
    f_blk_f = font("cn_bold", 20)
    f_strip = font("cn_bold", 19)
    f_strip_l = font("cn", 18)
    f_lbl = font("mono_bold", 17)
    f_cmd = font("mono_bold", 27)
    f_hint = font("cn", 19)
    f_mkt = font("cn", 18)
    f_repo = font("mono", 25)
    f_repo_b = font("mono_bold", 25)
    f_foot = font("cn_bold", 20)
    f_foot2 = font("mono", 20)

    # ---- eyebrow
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw_spaced(ImageDraw.Draw(layer), PAD, 74, "DEEPSEEK HARNESS × TYPESAFE JEV",
                f_eyebrow, CYAN, 5.5)
    img.alpha_composite(glow(layer, 14, 0.9))
    img.alpha_composite(layer)

    d = ImageDraw.Draw(img)

    # ---- H1
    # 标题必须覆盖全部四项能力，所以落到四者共有的那个动作上：判定 → 放行
    y1, y2 = 122, 218
    draw_at(d, PAD, y1, "关键节点", f_h1, INK)

    h1b = "先判定再放行"
    by2 = baseline(f_h1, y2)
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).text((u(PAD), u(by2)), h1b, font=f_h1, fill=255, anchor="ls")
    x0 = u(PAD)
    x1 = mask.getbbox()[2]
    grad = Image.new("RGBA", img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for x in range(x0, x1):
        t = (x - x0) / max(1, x1 - x0)
        col = (int(127 + (196 - 127) * t), int(227 + (168 - 227) * t), int(242 + (255 - 242) * t))
        gd.line([(x, 0), (x, img.height)], fill=col + (255,))
    img.alpha_composite(Image.composite(grad, Image.new("RGBA", img.size, (0, 0, 0, 0)), mask))
    d = ImageDraw.Draw(img)

    # ---- sub
    ys = 330
    by_sub = baseline(f_sub, ys)
    x = draw_at(d, PAD, ys, "把 ", f_sub, DIM, by=by_sub)
    x = draw_at(d, x, ys, "Jev 判定模型", f_sub_b, "#DCE7F7", by=by_sub)
    draw_at(d, x, ys, " 接进 DeepSeek Harness——", f_sub, DIM, by=by_sub)
    draw_at(d, PAD, ys + 41.5,
            "工具输出、抓回网页、技能选择、交付核对，每个节点都先过一遍判定。",
            f_sub, DIM)

    # ---- brand
    yb = 434
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).text((u(PAD), u(baseline(f_brand, yb))), "dsh-jev-tools",
                               font=f_brand, fill="#FFFFFF", anchor="ls")
    img.alpha_composite(glow(layer, 20, 0.5))
    img.alpha_composite(layer)
    d = ImageDraw.Draw(img)

    nw = d.textlength("dsh-jev-tools", font=f_brand) / SCALE
    px = PAD + nw + 20
    pill = (px, yb + 4, px + 96, yb + 40)
    paste_rrect(img, pill, 18, rgb_of(CYAN) + (28,))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(tuple(u(v) for v in pill), radius=u(18),
                        outline=rgb_of(CYAN) + (128,), width=max(1, u(1)))
    pw = d.textlength("v0.1.8", font=f_pill) / SCALE
    draw_at(d, px + (96 - pw) / 2, yb + 12, "v0.1.8", f_pill, "#9FE8F2")

    tx = pill[2] + 20
    d.line([(u(tx), u(yb + 6)), (u(tx), u(yb + 38))], fill=(255, 255, 255, 41), width=max(1, u(1)))
    draw_at(d, tx + 20, yb + 6, "判定，而非生成", f_tag, "#8FA3BE")

    # ---- feature grid（四个节点）
    gy, cw, ch, gap = 516, (CONTENT_W - 18) / 2, 172, 18
    cards = [
        (CYAN, "01", "精简工具输出", "超长工具结果逐段判定相关性，\n丢掉不相关的段落。", "实测 4613 → 2624 tokens"),
        (AMBER, "02", "注入筛查", "抓回的网页正文里，\n有没有写给 AI 的指令？", "只提醒 · 不拦截 · 不改写"),
        (VIOLET, "03", "技能推荐", "每轮首次组装 prompt 时，\n选出最匹配的一个 skill。", "目录 ≥ 15 个技能时启用"),
        (GREEN, "04", "jev_ask & jev_gate", "带类型的问题直接拿回概率；\n宣布「做完」前核对证据。", "闸门失败即升级，不放行"),
    ]

    blurred = img.convert("RGB").filter(ImageFilter.GaussianBlur(u(14)))
    for i, (accent, num, title, desc, metric) in enumerate(cards):
        cx = PAD + (i % 2) * (cw + gap)
        cy = gy + (i // 2) * (ch + gap)
        rgb = rgb_of(accent)
        glass_card(img, blurred, cx, cy, cw, ch, 20, rgb)
        d = ImageDraw.Draw(img)

        bx, by = cx + 24, cy + 20
        paste_rrect(img, (bx, by, bx + 40, by + 40), 12, rgb + (38,))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle((u(bx), u(by), u(bx + 40), u(by + 40)), radius=u(12),
                            outline=rgb + (107,), width=max(1, u(1)))
        nw2 = d.textlength(num, font=f_badge) / SCALE
        draw_at(d, bx + (40 - nw2) / 2, by + 9, num, f_badge, accent)

        draw_at(d, bx + 40 + 13, by + 4, title, f_card_h, "#F0F6FF")
        for j, line in enumerate(desc.split("\n")):
            draw_at(d, cx + 24, by + 40 + 10 + j * 29, line, f_card_p, "#96A9C2")
        draw_mixed(d, cx + 24, by + 40 + 10 + 58 + 10, metric,
                   f_metric, f_metric_m, accent)

    # ---- 为什么不是「再问一次 LLM」
    ky, kh = gy + 2 * ch + gap + 18, 176
    kbox = (PAD, ky, PAD + CONTENT_W, ky + kh)
    panel(img, kbox, 16, (8, 16, 30, 150), (255, 255, 255, 30))
    d = ImageDraw.Draw(img)

    # 这一格以前是「为什么不是再问一次 LLM」的两栏对照，现在换成预诊台类比。
    # 一次回答两个问题：Jev 是什么（左栏是那个熟悉的东西，右栏是映射关系），
    # 以及为什么不能拿它替代主模型（分诊不等于诊断）。技术上的精确差别
    # （同源、RLCD、三条后训练路线）留给 README——海报负责直觉，文档负责准确。
    draw_at(d, PAD + 24, ky + 18, "它像医院的预诊台：只判断该挂哪个科，不诊断",
            f_blk_h, "#DCE7F7")

    colw, colgap = 430, 28
    lx, rx = PAD + 24, PAD + 24 + colw + colgap
    hy = ky + 54
    d.line([(u(lx + colw + colgap / 2), u(hy + 4)), (u(lx + colw + colgap / 2), u(hy + 72))],
           fill=(255, 255, 255, 26), width=max(1, u(1)))

    for x, head, accent, bullets in (
        (lx, "医院的预诊台", GREY,
         ["听你说症状，几秒判断挂哪个科", "不知道你得的是什么病"]),
        (rx, "Jev · System One 判定模型", CYAN,
         ["读一份 state，返回选项与概率", "不解释理由，也不生成文本"]),
    ):
        draw_at(d, x, hy, head, f_blk_h, accent)
        for j, b in enumerate(bullets):
            by2 = hy + 28 + j * 26
            d.ellipse((u(x + 1), u(by2 + 9), u(x + 6), u(by2 + 14)), fill=accent)
            draw_at(d, x + 18, by2, b, f_blk_b, "#AEBFD4")

    draw_at(d, PAD + 24, ky + 140,
            "分诊不等于诊断——它不替代主模型，只在关键节点插一次高效判定。", f_blk_f, "#DCE7F7")

    # ---- 三条性质（作用域必须写明：闸门刻意相反）
    py, ph = ky + kh + 12, 42
    panel(img, (PAD, py, PAD + CONTENT_W, py + ph), 14, (8, 16, 30, 140), (255, 255, 255, 28))
    d = ImageDraw.Draw(img)
    x = draw_at(d, PAD + 24, py + 10, "精简与筛查共享：", f_strip_l, "#7E93AE")
    draw_at(d, x, py + 9, "只排序不卡阈值  ·  确定性保底  ·  失败即放行", f_strip, "#C6D6E9")

    # ---- install
    # `dsh plugin … add` 而不是 `npm install`：只有前者会在装包之后把包名写进
    # `dsh.profile.bundles`（plugin-manager 的 reconcile），而 DSH 只解析那个列表。
    # 纯 npm 安装会把包留在 node_modules 里、profile 一个字不改，DSH 永远不挂载它。
    iy, ih = py + ph + 12, 112
    panel(img, (PAD, iy, PAD + CONTENT_W, iy + ih), 16, (2, 6, 13, 150),
          rgb_of(CYAN) + (77,))
    d = ImageDraw.Draw(img)
    draw_spaced(d, PAD + 24, iy + 13, "INSTALL", f_lbl, "#5E7C99", 3.0)
    x = draw_at(d, PAD + 24, iy + 38, "$ ", f_cmd, GREEN)
    draw_at(d, x, iy + 38, "dsh plugin --profile web add dsh-jev-tools", f_cmd, "#EAF4FF")
    x = draw_at(d, PAD + 24, iy + 76, "或在 DSH 插件页按包名安装——", f_hint, "#7F93AD")
    x = draw_at(d, x, iy + 76, "一步完成安装并启用", f_hint, "#9FE8F2")

    # ---- repository + 市场收录
    # 包名可能重名，账户不会：把 HorusJiang 做成这一行里最醒目的部分。
    ry, rh = iy + ih + 12, 80
    panel(img, (PAD, ry, PAD + CONTENT_W, ry + rh), 14, (8, 16, 30, 155),
          rgb_of(CYAN) + (56,))
    d = ImageDraw.Draw(img)
    draw_spaced(d, PAD + 24, ry + 11, "REPOSITORY", f_lbl, "#5E7C99", 3.0)
    markets = "已收录 awesome-dsh-plugin 权威目录（16.6k★），dsh-market 等镜像商城自动同步"
    mw = width_of(d, markets, f_mkt)
    draw_mixed(d, PAD + CONTENT_W - 24 - mw, ry + 12, markets, f_mkt, f_mkt, "#5E7C99")
    x = draw_at(d, PAD + 24, ry + 38, "github.com/", f_repo, "#7F93AD")
    x = draw_at(d, x, ry + 38, "HorusJiang", f_repo_b, CYAN)
    draw_at(d, x, ry + 38, "/dsh-jev-tools", f_repo_b, "#EAF4FF")

    # ---- footer
    fy = 1360
    draw_at(d, PAD, fy, "无 key 时完全惰性 · 不发任何网络请求", f_foot, "#86C9A8")
    right = "MIT · 243 tests"
    rw = d.textlength(right, font=f_foot2) / SCALE
    draw_at(d, PAD + CONTENT_W - rw, fy + 2, right, f_foot2, "#7A8DA6")


def main() -> None:
    img = build_background()
    draw_topbar(img)
    draw_content(img)
    img.convert("RGB").save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT}  {img.width}x{img.height}  {os.path.getsize(OUT)} bytes")


if __name__ == "__main__":
    sys.exit(main())
