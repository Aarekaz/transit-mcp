"""Draws the four diagrams on /docs as inline SVG and writes each between its markers in
public/docs/index.html (<!-- dg:NAME --> … <!-- /dg:NAME -->).

    python3 media/docs-diagrams/build.py

Every number comes from production on Saturday, October 24 2026: the timing log of a
get_departures call (`wrangler tail`, event tool_timing), the board it returned, and the
station positions find_transit and the ENTITY_AMBIGUOUS answer report. The page's CSS
colours them (.dg-*), so they follow its light and dark themes."""
import math
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
PAGE = ROOT / "public/docs/index.html"


def esc(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def text(x, y, value, cls="dg-label", anchor="start", size=None):
    style = f' font-size="{size}"' if size else ""
    return f'<text class="{cls}" x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}"{style}>{esc(value)}</text>'


def box(x, y, w, h, title, sub=None, accent=False, dashed=False):
    cls = "dg-box dg-accent-box" if accent else "dg-box"
    dash = ' stroke-dasharray="4 3"' if dashed else ""
    out = [f'<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="8"{dash}/>']
    if sub:
        out.append(text(x + w / 2, y + h / 2 - 4, title, "dg-title", "middle"))
        out.append(text(x + w / 2, y + h / 2 + 13, sub, "dg-sub", "middle"))
    else:
        out.append(text(x + w / 2, y + h / 2 + 4, title, "dg-title", "middle"))
    return "".join(out)


def arrow(points, label=None, at=None, anchor="middle", cls="dg-line"):
    d = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in points)
    out = [f'<path class="{cls}" d="{d}" marker-end="url(#{{id}}-arrow)"/>']
    if label:
        lx, ly = at
        out.append(text(lx, ly, label, "dg-edge", anchor))
    return "".join(out)


def svg(name, width, height, label, body):
    defs = (f'<defs><marker id="{name}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M0 1 L9 5 L0 9 Z" class="dg-head"/></marker></defs>')
    return (f'<svg class="dg" viewBox="0 0 {width} {height}" role="img" aria-label="{esc(label)}" xmlns="http://www.w3.org/2000/svg">'
            + defs + "".join(body).replace("{id}", name) + "</svg>")


def figure(name, width, height, label, body, caption):
    return f'<figure class="dg-figure"><div class="dg-scroll">{svg(name, width, height, label, body)}</div><figcaption>{caption}</figcaption></figure>'


# 1. What happened inside one call ------------------------------------------------------
def call_path():
    W, H, w, h, y = 800, 262, 136, 62, 168
    xs = [8 + i * 158 for i in range(5)]
    cx = [x + w / 2 for x in xs]
    body = []
    # The two clocks, above the request: the timetable store and the live feed coordinator.
    body.append(box(xs[1], 22, xs[2] + w - xs[1], 54, "Timetable store (R2)", "built ahead: 9 days in 3-hour bands"))
    body.append(box(xs[3], 22, w, 54, "Feed coordinator", "polls MTA every 30 s"))
    body.append(arrow([(cx[1], 76), (cx[1], y - 2)], "name index · 16 MB", (cx[1] + 8, 124), "start"))
    body.append(arrow([(cx[2], 76), (cx[2], y - 2)], "3 bands · 4.8 MB", (cx[2] + 8, 124), "start"))
    body.append(arrow([(cx[3], 76), (cx[3], y - 2)], "snapshot · 0.6 s", (cx[3] + 8, 124), "start"))
    nodes = [("Rider's words", "“14 St on the 1”"), ("Resolve the name", "14 St (1, 2, 3)"), ("Read timetable", "trips due around 13:20"),
             ("Apply live data", "matched trip by trip"), ("Answer", "status: realtime, asOf")]
    for i, (title, sub) in enumerate(nodes):
        body.append(box(xs[i], y, w, h, title, sub, accent=i == 4))
        if i < 4:
            body.append(arrow([(xs[i] + w + 2, y + h / 2), (xs[i + 1] - 3, y + h / 2)]))
    return figure("dg-call", W, H,
                  "The call above, step by step: the rider's words are resolved with a name index read from the timetable store, the trips due around now are read from three timetable bands, live predictions come from the feed coordinator's snapshot, and the answer carries status realtime and asOf.",
                  body,
                  "What the server did to answer the call above, from its own timing log. The timetable is built ahead of time and the live feed is polled all the time, so the call only reads. "
                  "On a server that hadn't answered for New York recently, it read 25 MB in 14 reads and took 4 to 5 seconds, most of it loading the name index. A server that has answered recently keeps that in memory.")


# 2. One place or five ---------------------------------------------------------------------
TIMES_SQ = [("N Q R W", 40.754672, -73.986754), ("1 2 3", 40.75529, -73.987495), ("7", 40.755477, -73.987691), ("S", 40.755983, -73.986229)]
ST_86 = [("4 5 6", 40.779492, -73.955589), ("A B C D", 40.785868, -73.968916), ("1 2", 40.788644, -73.976218), ("N W", 40.592721, -73.97823), ("R", 40.622687, -74.028398)]


def metres(points):
    lat0 = sum(p[1] for p in points) / len(points)
    lon0 = sum(p[2] for p in points) / len(points)
    k = math.cos(math.radians(lat0))
    return [(name, (lon - lon0) * k * 111_320, (lat0 - lat) * 110_540) for name, lat, lon in points]


def one_place():
    W, H = 800, 330
    body = []
    # Left: Times Sq-42 St, 1 px = 0.6 m, with the 200 m radius the server uses.
    s, ox, oy = 0.6, 190, 150
    pts = metres(TIMES_SQ)
    centre = pts[1]
    body.append(f'<circle class="dg-zone" cx="{ox}" cy="{oy}" r="{200 * s:.1f}" stroke-dasharray="4 4"/>')
    body.append(text(ox, oy - 200 * s - 8, "200 m", "dg-edge", "middle"))
    for name, x, y in pts:
        px, py = ox + (x - centre[1]) * s, oy + (y - centre[2]) * s
        body.append(f'<circle class="dg-dot" cx="{px:.1f}" cy="{py:.1f}" r="5"/>')
        body.append(text(px + 9, py + 4, name, "dg-sub"))
    body.append(text(ox, 300, "Times Sq-42 St: 4 stations, 152 m apart", "dg-title", "middle"))
    body.append(text(ox, 318, "one place → one answer", "dg-accent-text", "middle"))
    # Scale bar: 50 m.
    body.append(f'<path class="dg-line-plain" d="M{ox - 15:.1f} 270 L{ox + 50 * s - 15:.1f} 270"/>')
    body.append(text(ox - 15 + 25 * s, 264, "50 m", "dg-edge", "middle"))
    # Right: 86 St, 1 px = 100 m. The three Manhattan stations sit within 2 km, so they share one label.
    s2, ox2, oy2 = 1 / 100, 600, 40
    pts2 = metres(ST_86)
    top = min(y for _, _, y in pts2)
    xmid = sum(x for _, x, _ in pts2) / len(pts2)
    at = {name: (ox2 + (x - xmid) * s2, oy2 + (y - top) * s2) for name, x, y in pts2}
    for name, (px, py) in at.items():
        body.append(f'<circle class="dg-dot" cx="{px:.1f}" cy="{py:.1f}" r="4.5"/>')
    lx = min(at[n][0] for n in ("1 2", "A B C D", "4 5 6"))
    my = sum(at[n][1] for n in ("1 2", "A B C D", "4 5 6")) / 3
    body.append(text(lx - 14, my - 2, "1 2 · A B C D · 4 5 6", "dg-sub", "end"))
    body.append(text(lx - 14, my + 13, "Manhattan, 0.7 to 2 km apart", "dg-edge", "end"))
    for name in ("N W", "R"):
        px, py = at[name]
        body.append(text(px + 10, py + 4, name, "dg-sub"))
    body.append(text(at["R"][0] - 14, at["R"][1] + 4, "Brooklyn", "dg-edge", "end"))
    body.append(f'<path class="dg-line-plain" d="M{ox2 + 60:.1f} 270 L{ox2 + 60 + 5000 * s2:.1f} 270"/>')
    body.append(text(ox2 + 60 + 2500 * s2, 264, "5 km", "dg-edge", "middle"))
    body.append(text(ox2, 300, "86 St: 5 stations, 0.7 to 22 km apart", "dg-title", "middle"))
    body.append(text(ox2, 318, "five places → ask the rider which", "dg-accent-text", "middle"))
    body.append('<path class="dg-divider" d="M400 20 L400 320"/>')
    return figure("dg-place", W, H,
                  "Two maps to scale. Left: the four Times Sq-42 St stations, all within a 200 metre circle, are treated as one place. Right: the five 86 St stations, three in Manhattan and two in Brooklyn, 0.7 to 22 km apart, are five places, so the server asks which one.",
                  body,
                  "Same name, different answers, on the real station positions. Stations with the same name count as one place when they're within 200 m of each other or linked by published transfers. Otherwise the server asks.")


# 3. Scheduled vs predicted -------------------------------------------------------------
BOARD = [("1", "238 St", "13:23:30", "13:22:49"), ("2", "Wakefield-241 St", "13:25:30", "13:27:33"), ("3", "Harlem-148 St", "13:28:30", "13:29:02"),
         ("1", "238 St", "13:31:30", "13:31:38"), ("2", "Wakefield-241 St", "13:33:30", "13:32:15"), ("3", "Harlem-148 St", "13:37:30", "13:37:46")]
AS_OF = "13:20:13"


def seconds(clock):
    h, m, s = (int(part) for part in clock.split(":"))
    return h * 3600 + m * 60 + s


def board():
    W, H = 800, 290
    x0, x1, t0, t1 = 210, 780, seconds("13:20:00"), seconds("13:40:00")
    X = lambda clock: x0 + (seconds(clock) - t0) / (t1 - t0) * (x1 - x0)
    body = []
    for minute in range(20, 41, 5):
        x = X(f"13:{minute}:00")
        body.append(f'<path class="dg-grid" d="M{x:.1f} 30 L{x:.1f} 236"/>')
        body.append(text(x, 254, f"13:{minute}", "dg-edge", "middle"))
    ax = X(AS_OF)
    body.append(f'<path class="dg-now" d="M{ax:.1f} 18 L{ax:.1f} 236" stroke-dasharray="3 3"/>')
    body.append(text(ax + 4, 14, "asOf 13:20", "dg-edge"))
    for i, (line, headsign, due, predicted) in enumerate(BOARD):
        y = 46 + i * 32
        body.append(f'<circle class="dg-badge" cx="20" cy="{y - 4}" r="10"/>')
        body.append(text(20, y, line, "dg-badge-text", "middle"))
        body.append(text(38, y, headsign, "dg-sub"))
        sx, px = X(due), X(predicted)
        body.append(f'<path class="dg-tick" d="M{sx:.1f} {y - 13} L{sx:.1f} {y + 5}"/>')
        body.append(f'<path class="dg-line-plain" d="M{min(sx, px):.1f} {y - 4} L{max(sx, px):.1f} {y - 4}"/>')
        body.append(f'<circle class="dg-dot dg-accent-dot" cx="{px:.1f}" cy="{y - 4}" r="5"/>')
        delta = seconds(predicted) - seconds(due)
        sign = "+" if delta >= 0 else "−"
        body.append(text(max(sx, px) + 10, y, f"{sign}{abs(delta) // 60}:{abs(delta) % 60:02d}", "dg-edge"))
    body.append(f'<path class="dg-tick" d="M{x0} 272 L{x0} 284"/>')
    body.append(text(x0 + 8, 282, "scheduledTime", "dg-edge"))
    body.append(f'<circle class="dg-dot dg-accent-dot" cx="{x0 + 120}" cy="278" r="5"/>')
    body.append(text(x0 + 130, 282, "predictedTime", "dg-edge"))
    return figure("dg-board", W, H,
                  "The departure board at 14 St at 13:20 on October 24: six trains on the 1, 2 and 3, each with its scheduled time and its live prediction, from 41 seconds early to 2 minutes 3 seconds late.",
                  body,
                  "The real board at 14 St, read at 13:20 on October 24 (times in New York). Each tick is the timetable and each dot is the live prediction, between 41 s early and 2 min 3 s late. "
                  "Every train here had a prediction, so each is <code>realtime</code>. A train without one keeps only its tick: <code>predictedTime</code> is <code>null</code> and its status is <code>scheduled_only</code>.")


# 4. How a new timetable goes live ------------------------------------------------------
def pipeline():
    W, H = 800, 250
    body = []
    row, h = 28, 58
    nodes = [(6, 128, "MTA uploads", "about hourly"), (158, 136, "Tables changed?", "checksums, no unzip"), (318, 150, "Touches today?", "\u00b1 1 day \u00b7 diff, 0.1 s"),
             (492, 138, "Build", "9 days, ~140 s CPU"), (654, 140, "Validate, publish", "")]
    for i, (x, w, title, sub) in enumerate(nodes):
        body.append(box(x, row, w, h, title, sub or None, accent=i == 4, dashed=i in (1, 2)))
    y = row + h / 2
    body.append(arrow([(134, y), (155, y)]))
    body.append(arrow([(294, y), (315, y)]))
    body.append(arrow([(468, y), (489, y)]))
    body.append(arrow([(630, y), (651, y)]))
    # "no" branches.
    body.append(box(158, 150, 136, 46, "Skip", "same tables, new zip"))
    body.append(arrow([(226, row + h), (226, 147)], "if no", (234, 124), "start"))
    body.append(box(318, 150, 150, 46, "Wait up to 6 h", "then build"))
    body.append(arrow([(393, row + h), (393, 147)], "if no", (401, 124), "start"))
    body.append(arrow([(468, 173), (561, 173), (561, row + h + 3)]))
    # After publishing: rolled back if live matching gets worse.
    body.append(box(654, 150, 140, 46, "Roll back", "if live matching drops"))
    body.append(arrow([(724, row + h), (724, 147)], "watch", (732, 124), "start"))
    body.append(text(6, 232, "Checked every 5 minutes. A change that touches yesterday, today or tomorrow never waits.", "dg-edge"))
    return figure("dg-pipeline", W, H,
                  "How a new MTA subway timetable goes live: an upload whose tables are unchanged is skipped; a change touching yesterday, today or tomorrow is built at once; a change only to later days waits up to six hours; each build is validated and published, then rolled back if live matching drops.",
                  body,
                  "How a new NYC subway timetable goes live. The two dashed boxes are the cheap checks that save the expensive build: in the last day sampled, one upload in three was the same tables in a new zip, and every change was to planned work two or more days out.")


DIAGRAMS = {"call": call_path(), "place": one_place(), "board": board(), "pipeline": pipeline()}

html = PAGE.read_text()
for name, markup in DIAGRAMS.items():
    start, end = f"<!-- dg:{name} -->", f"<!-- /dg:{name} -->"
    if start not in html:
        raise SystemExit(f"marker {start} missing from {PAGE}")
    html = re.sub(re.escape(start) + r".*?" + re.escape(end), lambda _: f"{start}\n{markup}\n{end}", html, flags=re.S)
PAGE.write_text(html)
print("wrote", ", ".join(DIAGRAMS))
