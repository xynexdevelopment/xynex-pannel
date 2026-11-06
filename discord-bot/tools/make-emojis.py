"""Generates the bot's custom emoji set (128x128 PNG + animated spinner GIF) into ../emojis/.
Run:  python3 tools/make-emojis.py      (needs Pillow)
The bot uploads any missing ones as *application emojis* on startup - nothing to do by hand."""
import math, os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "emojis")
os.makedirs(OUT, exist_ok=True)
S, F = 512, 128            # draw size, final size
C = S // 2

GREEN, RED, AMBER = (46, 204, 113), (255, 93, 93), (250, 176, 5)
BLUE, VIOLET, CYAN = (77, 150, 255), (140, 110, 255), (34, 211, 238)
ORANGE, TEAL, SLATE = (255, 138, 61), (45, 212, 191), (148, 163, 184)
WHITE, DARK = (255, 255, 255), (30, 34, 48)

def canvas():
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)

def save(im, name):
    im.resize((F, F), Image.LANCZOS).save(os.path.join(OUT, name + ".png"))

def dot(color):
    im, d = canvas()
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0)); g = ImageDraw.Draw(glow)
    g.ellipse([40, 40, S - 40, S - 40], fill=color + (70,))
    im.alpha_composite(glow)
    d.ellipse([90, 90, S - 90, S - 90], fill=color)
    d.ellipse([140, 130, 270, 230], fill=tuple(min(255, c + 70) for c in color) + (200,))
    return im

def circle_icon(color, glyph):
    im, d = canvas()
    d.ellipse([30, 30, S - 30, S - 30], fill=color)
    glyph(d)
    return im

def arc_arrow(color, width=64, gap=60):
    im, d = canvas()
    box = [70, 70, S - 70, S - 70]
    d.arc(box, start=-90 + gap, end=270 - 20, fill=color, width=width)
    # arrow head at the arc start
    ang = math.radians(-90 + gap)
    r = (S - 140) / 2 - width / 2 + width / 2
    cx, cy = C + r * math.cos(ang), C + r * math.sin(ang)
    d.polygon([(cx - 70, cy - 10), (cx + 70, cy - 10), (cx, cy + 90)], fill=color)
    return im

# ---- status dots ----
save(dot(GREEN), "online"); save(dot(RED), "offline"); save(dot(AMBER), "idle")

# ---- power ----
im, d = canvas(); d.polygon([(150, 80), (150, 432), (440, 256)], fill=GREEN); d.line([(150, 80), (150, 432), (440, 256), (150, 80)], fill=GREEN, width=36, joint="curve"); save(im, "start")
im, d = canvas(); d.rounded_rectangle([100, 100, 412, 412], radius=70, fill=RED); save(im, "stop")
save(arc_arrow(BLUE), "restart")
save(arc_arrow(SLATE, 56, 70), "refresh")
def x_glyph(d):
    d.line([(165, 165), (347, 347)], fill=WHITE, width=56); d.line([(347, 165), (165, 347)], fill=WHITE, width=56)
save(circle_icon(RED, x_glyph), "kill"); save(circle_icon(RED, x_glyph), "cross")
def check_glyph(d): d.line([(140, 270), (225, 355), (375, 175)], fill=WHITE, width=60, joint="curve")
save(circle_icon(GREEN, check_glyph), "check")

# ---- players ----
im, d = canvas()
d.ellipse([290, 90, 440, 240], fill=VIOLET + (150,)); d.pieslice([250, 230, 480, 480], 180, 360, fill=VIOLET + (150,))
d.ellipse([110, 70, 290, 250], fill=VIOLET); d.pieslice([60, 240, 340, 520], 180, 360, fill=VIOLET)
save(im, "players")

# ---- console ----
im, d = canvas()
d.rounded_rectangle([40, 70, S - 40, S - 70], radius=60, fill=DARK, outline=SLATE, width=14)
d.line([(130, 180), (220, 256), (130, 332)], fill=GREEN, width=44, joint="curve")
d.line([(260, 340), (390, 340)], fill=GREEN, width=44)
save(im, "console")

# ---- backup (floppy) ----
im, d = canvas()
d.rounded_rectangle([60, 60, S - 60, S - 60], radius=50, fill=BLUE)
d.rectangle([150, 60, 360, 200], fill=WHITE); d.rectangle([290, 80, 335, 180], fill=BLUE)
d.rounded_rectangle([130, 270, 382, S - 60], radius=20, fill=(225, 235, 255))
save(im, "backup")

# ---- cpu ----
im, d = canvas()
for k in range(4):
    p = 140 + k * 77
    d.line([(p, 50), (p, 130)], fill=ORANGE, width=26); d.line([(p, S - 130), (p, S - 50)], fill=ORANGE, width=26)
    d.line([(50, p), (130, p)], fill=ORANGE, width=26); d.line([(S - 130, p), (S - 50, p)], fill=ORANGE, width=26)
d.rounded_rectangle([105, 105, S - 105, S - 105], radius=36, fill=ORANGE)
d.rounded_rectangle([185, 185, S - 185, S - 185], radius=18, fill=(255, 200, 150))
save(im, "cpu")

# ---- ram ----
im, d = canvas()
d.rounded_rectangle([30, 130, S - 30, 360], radius=34, fill=GREEN)
for k in range(4): d.rounded_rectangle([75 + k * 95, 180, 135 + k * 95, 300], radius=10, fill=(20, 110, 60))
for k in range(8): d.rectangle([60 + k * 52, 360, 84 + k * 52, 420], fill=AMBER)
save(im, "ram")

# ---- disk (cylinder) ----
im, d = canvas()
d.rectangle([90, 130, S - 90, 380], fill=VIOLET)
d.ellipse([90, 300, S - 90, 450], fill=VIOLET); d.ellipse([90, 60, S - 90, 210], fill=(185, 165, 255))
d.arc([90, 160, S - 90, 310], 0, 180, fill=(210, 195, 255), width=18)
save(im, "disk")

# ---- network ----
im, d = canvas()
d.polygon([(165, 70), (60, 210), (140, 210), (140, 440), (190, 440), (190, 210), (270, 210)], fill=CYAN)
d.polygon([(347, 442), (242, 302), (322, 302), (322, 72), (372, 72), (372, 302), (452, 302)], fill=BLUE)
save(im, "network")

# ---- globe ----
im, d = canvas()
d.ellipse([50, 50, S - 50, S - 50], outline=TEAL, width=34)
d.ellipse([150, 50, S - 150, S - 50], outline=TEAL, width=24)
d.line([(50, C), (S - 50, C)], fill=TEAL, width=24)
d.line([(100, 150), (S - 100, 150)], fill=TEAL, width=18); d.line([(100, 362), (S - 100, 362)], fill=TEAL, width=18)
save(im, "globe")

# ---- cube ----
im, d = canvas()
d.polygon([(C, 40), (450, 140), (C, 240), (62, 140)], fill=(190, 175, 255))
d.polygon([(62, 140), (C, 240), (C, 472), (62, 372)], fill=VIOLET)
d.polygon([(450, 140), (C, 240), (C, 472), (450, 372)], fill=(110, 80, 235))
save(im, "cube")

# ---- gauge (limits) ----
im, d = canvas()
d.arc([50, 90, S - 50, S + 140], 180, 360, fill=SLATE, width=50)
d.arc([50, 90, S - 50, S + 140], 180, 300, fill=AMBER, width=50)
d.line([(C, 340), (390, 190)], fill=WHITE, width=30); d.ellipse([C - 36, 304, C + 36, 376], fill=WHITE)
save(im, "gauge")

# ---- clock ----
im, d = canvas()
d.ellipse([50, 50, S - 50, S - 50], outline=ORANGE, width=40)
d.line([(C, C), (C, 130)], fill=ORANGE, width=36); d.line([(C, C), (370, 300)], fill=ORANGE, width=36)
d.ellipse([C - 26, C - 26, C + 26, C + 26], fill=ORANGE)
save(im, "clock")

# ---- server (title icon) ----
im, d = canvas()
for k, y in enumerate((60, 190, 320)):
    d.rounded_rectangle([50, y, S - 50, y + 120], radius=28, fill=VIOLET if k != 1 else (110, 80, 235))
    d.ellipse([100, y + 38, 144, y + 82], fill=GREEN if k != 2 else AMBER)
    d.rounded_rectangle([190, y + 48, 400, y + 72], radius=12, fill=(220, 210, 255))
save(im, "server")

# ---- loading spinner (animated GIF) ----
frames = []
for k in range(12):
    im, d = canvas()
    for j in range(12):
        a = math.radians(j * 30 - 90)
        age = (j - k) % 12
        alpha = int(255 * (1 - age / 12) ** 1.5) + 25
        x, y = C + 170 * math.cos(a), C + 170 * math.sin(a)
        r = 34
        d.ellipse([x - r, y - r, x + r, y + r], fill=VIOLET + (min(255, alpha),))
    frames.append(im.resize((F, F), Image.LANCZOS))
frames[0].save(os.path.join(OUT, "loading.gif"), save_all=True, append_images=frames[1:], duration=70, loop=0, disposal=2, transparency=0)
print("done:", sorted(os.listdir(OUT)))
