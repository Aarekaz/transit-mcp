// Fig 1 for /docs: the timetable rack reader. Drawn with the Anatomy kit
// (kit/iso-kit.mjs, MIT, github.com/wheresryan22/anatomy at 1482e8469b0a).
//   node build.mjs            → preview pages (dark and light) in out/, and the figure
//                               written into public/docs/index.html between its markers
// The kit itself is served to the docs page as /docs/iso-kit.js.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./kit/iso-kit.mjs";
import * as M from "./model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, "../../public/docs");
const WIDTH = 680, HEIGHT = 420;

// World units; x along the rack, y toward the front, z up.
const PLATE = { x: -170, y: -80, w: 292, d: 146, r: 8 };
const PLATE_H = 12, FOOT_H = 5;
const CARD_X = Array.from({ length: M.DAYS }, (_, day) => -112 + day * 24);
const CARD = { y: -54, d: 22, t: 3.2, z: 7, h: 32 };
const CARD_TOP = CARD.z + CARD.h;
const TROUGH = { x: -126, y: -58, w: 218, d: 30, r: 3 };
const RAIL_X = [-140, 106];
const RAILS_Y = [6, 30];
const CARRIAGE = { x: -22, y: 0, w: 44, d: 40, r: 3 };
const CAR_Z = 3, CAR_TOP = 9;
const DIAL = [0, 22], DIAL_R = 12, DIAL_TOP = CAR_TOP + 8;
const MINUTES_PER_TURN = 10;
const SPOOL = [-146, -50], SPOOL_Z = 52, SPOOL_R = 10;
const TICKER = { x: -162, y: -72, w: 32, d: 44, r: 3 };
const SWITCH = { on: -140, off: -152, y: -33 };
const TAPE_FROM = [SPOOL[0] + SPOOL_R * 0.94, SPOOL[1] + SPOOL_R * 0.34, SPOOL_Z + 4];
const TAPE_TO = [CARD_X[M.TODAY], CARD.y + 11, CARD_TOP + 1.6];

const P = k.fitProjection(
  [...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0), [SPOOL[0], SPOOL[1], SPOOL_Z + 10], ...CARD_X.map((x) => [x, CARD.y, CARD_TOP + 2])],
  WIDTH, HEIGHT, { pad: 22, azimuth: Number(process.env.AZ ?? 44) },
);
const at = (point) => k.iso(point, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));

function plate() {
  const out = [`<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`];
  for (const [x, y] of byDepth(k.corners(PLATE, 22))) {
    out.push(S(k.cylinder(x, y, 7, -PLATE_H - FOOT_H, 1.6, P, 28), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, 5.4, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: "mid" }));
  }
  out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.6), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(PLATE, 5), 0, P), { tone: "lo" }));
  const screws = k.corners(PLATE, 10);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 2.2, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));
  // Ruler under the rails: a major tick under every card.
  const strip = { x: -120, y: 50, w: 208, d: 7, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(CARD_X[0], CARD_X[M.DAYS - 1], 6, 4, strip.y + 0.8, 0.6, [2, 3.8], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(D([at([strip.x + 2.5, strip.y + 3.5, 0.6]), at([strip.x + strip.w - 2.5, strip.y + 3.5, 0.6])], { size: 0.45 }));
  // Today's tick is the zero mark.
  out.push(L(k.lineOnTop([CARD_X[M.TODAY], strip.y + 0.8], [CARD_X[M.TODAY], strip.y + 5.4], 0.6, P), { tone: "hi" }));
  // Label plate.
  const label = { x: -160, y: 42, w: 34, d: 18, r: 2 };
  out.push(S(k.slabOf(label, 0, 0.8, P, 4), { tone: "lo", crease: "none" }));
  out.push(L(k.planOutline(k.insetPlan(label, 1.6), 0.8, P, 3), { tone: "faint" }));
  [[22, 5], [16, 9], [19, 13]].forEach(([w, y]) => out.push(L(k.lineOnTop([label.x + 6, label.y + y], [label.x + 6 + w, label.y + y], 0.8, P), { tone: "lo", free: true })));
  out.push(D([at([label.x + 3, label.y + 3, 0.8]), at([label.x + label.w - 3, label.y + label.d - 3, 0.8])], { size: 0.45 }));
  return out.join("");
}

// The live feed: a spool of ticker tape on a post, and the switch that cuts it.
function ticker() {
  const out = [`<path class="iso-halo" d="${k.haloOf(k.insetPlan(TICKER, 3), 0, 0.1, P)}" style="filter:blur(4px)"/>`];
  out.push(S(k.slabOf(TICKER, 0, 10, P, 5, 0.8), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(TICKER, 3.5), 10, P, 4), { tone: "faint" }));
  out.push(D(k.corners(TICKER, 5).map(([x, y]) => at([x, y, 10])), { size: 0.45 }));
  // The switch slot and its stops; the knob is live.
  const slot = { x: SWITCH.off - 3, y: SWITCH.y - 1.4, w: SWITCH.on - SWITCH.off + 6, d: 2.8, r: 1.4 };
  out.push(L(k.planOutline(slot, 10, P, 3), { tone: "lo" }));
  out.push(D([at([SWITCH.on + 5.5, SWITCH.y - 3.4, 10])], { size: 0.5, tone: "hi" }));
  // Post, collar and the spool.
  const [x, y] = SPOOL;
  out.push(S(k.cylinder(x, y, 5, 10, 3, P, 28), { tone: "mid" }));
  out.push(S(k.cylinder(x, y, 2.6, 13, SPOOL_Z - 13, P, 24), { tone: "mid", crease: "none" }));
  out.push(L([22, 32].map((z) => k.sideArc(x, y, 2.6, z, P, 12)).join(""), { tone: "faint" }));
  out.push(S(k.cylinder(x, y, SPOOL_R, SPOOL_Z, 1.2, P, 56, 0.4), { tone: "mid" }));
  out.push(S(k.cylinder(x, y, SPOOL_R - 2.2, SPOOL_Z + 1.2, 6, P, 48), { tone: "hi", crease: "none" }));
  out.push(L([2.4, 4.4].map((dz) => k.sideArc(x, y, SPOOL_R - 2.2, SPOOL_Z + 1.2 + dz, P, 32)).join(""), { tone: "faint" }));
  out.push(S(k.cylinder(x, y, SPOOL_R, SPOOL_Z + 7.2, 1.2, P, 56, 0.4), { tone: "mid" }));
  out.push(L(k.ring(x, y, 3, SPOOL_Z + 8.4, P, 20), { tone: "lo" }));
  out.push(D(byDepth([0, 1, 2, 3].map((i) => [x + Math.cos(i * Math.PI / 2 + 0.4) * 6.4, y + Math.sin(i * Math.PI / 2 + 0.4) * 6.4])).map(([px, py]) => at([px, py, SPOOL_Z + 8.4])), { size: 0.45 }));
  return out.join("");
}

function switchKnob() {
  return S(k.cylinder(0, SWITCH.y, 2.4, 10, 4, P, 20), { tone: "hi", crease: "lo" }) + L(k.ring(0, SWITCH.y, 1, 14, P, 12), { tone: "lo" });
}

function trough() {
  const out = [S(k.slabOf(TROUGH, 0, 7, P, 4, 0.6), { tone: "mid" })];
  out.push(L(k.planOutline(k.insetPlan(TROUGH, 3), 7, P, 3), { tone: "faint" }));
  out.push(D([at([TROUGH.x + 4, TROUGH.y + 12, 7]), at([TROUGH.x + TROUGH.w - 4, TROUGH.y + 12, 7])], { size: 0.45 }));
  return out.join("");
}

// One card per service day, standing in its slot; today's is the lit part.
function card(day) {
  const x = CARD_X[day], lit = day === M.TODAY;
  const plan = { x: x - CARD.t / 2, y: CARD.y, w: CARD.t, d: CARD.d, r: 0.6 };
  const out = [L(k.planOutline(k.insetPlan(plan, -1), CARD.z, P, 2), { tone: "lo" })];
  out.push(S(k.slabOf(plan, CARD.z, CARD.h, P, 2, 0.3), { tone: lit ? "hi" : "mid", crease: "lo", lit }));
  // Printed rows on the face toward the viewer: the day's trips.
  const face = x + CARD.t / 2;
  const rows = [];
  for (let z = CARD.z + 5; z < CARD_TOP - 5; z += 3.2) {
    const long = (Math.round(z * 7 + day * 3) % 3) * 2;
    rows.push(k.segment([face, CARD.y + 2, z], [face, CARD.y + 8 + long, z], P));
  }
  out.push(L(rows.join(""), { tone: lit ? "mid" : "lo", free: true }));
  // An index tab on top, stepped along the rack like a card file.
  const tab = { x: x - CARD.t / 2, y: CARD.y + 1.5 + (day % 3) * 6.5, w: CARD.t, d: 4.5, r: 0.4 };
  out.push(S(k.slabOf(tab, CARD_TOP, 2.2, P, 2), { tone: lit ? "hi" : "mid", crease: "none", lit }));
  if (lit) out.push(S(k.slabOf({ x: x - 2.4, y: TAPE_TO[1] - 2.2, w: 4.8, d: 4.4, r: 0.8 }, CARD_TOP, 1.6, P, 2), { tone: "mid", crease: "none" }));
  return out.join("");
}

function rails() {
  const out = [];
  for (const y of RAILS_Y) {
    out.push(S(k.slabOf({ x: RAIL_X[0], y, w: RAIL_X[1] - RAIL_X[0], d: 4, r: 1 }, 0, 3, P, 3, 0.4), { tone: "mid" }));
    out.push(D([RAIL_X[0] + 8, RAIL_X[1] - 8].map((x) => at([x, y + 2, 3])), { size: 0.4 }));
  }
  for (const x of [RAIL_X[0] - 6, RAIL_X[1]]) {
    out.push(S(k.slabOf({ x, y: 2, w: 6, d: 36, r: 1.2 }, 0, 7, P, 3, 0.5), { tone: "mid" }));
    out.push(D([at([x + 3, 7, 7]), at([x + 3, 33, 7])], { size: 0.45 }));
  }
  return out.join("");
}

// The reader, built at x = 0 and moved along the rail to the day being asked about.
function carriage() {
  const out = [`<path class="iso-halo" d="${k.haloOf(k.insetPlan(CARRIAGE, 3), CAR_Z, 0.1, P)}" style="filter:blur(4px)"/>`];
  out.push(S(k.slabOf(CARRIAGE, CAR_Z, CAR_TOP - CAR_Z, P, 5, 0.6), { tone: "mid" }));
  for (const [x, y] of byDepth(k.corners(CARRIAGE, 6))) {
    out.push(S(k.slabOf({ x: x - 4, y: y - 3, w: 8, d: 6, r: 1 }, CAR_TOP, 2.4, P, 2, 0.3), { tone: "mid", crease: "lo" }));
    out.push(D([at([x, y, CAR_TOP + 2.4])], { size: 0.4 }));
  }
  out.push(D([-14, -5, 5, 14].map((x) => at([x, CARRIAGE.y + CARRIAGE.d - 2.4, CAR_TOP])), { size: 0.4, tone: "lo" }));
  // Riser and arm out to the card face, ending in a reading head.
  const riser = { x: -5, y: 1, w: 10, d: 7, r: 1.2 };
  out.push(S(k.slabOf(riser, CAR_TOP, 10, P, 3, 0.4), { tone: "mid" }));
  const armY = CARD.y + CARD.d + 1.2;
  out.push(S(k.slabOf({ x: -3, y: armY, w: 6, d: riser.y + 4 - armY, r: 1 }, CAR_TOP + 7, 3.4, P, 3, 0.4), { tone: "mid" }));
  out.push(D([at([0, armY + 6, CAR_TOP + 10.4]), at([0, riser.y + 2, CAR_TOP + 10.4])], { size: 0.4 }));
  out.push(S(k.slabOf({ x: -4.2, y: armY - 1, w: 8.4, d: 3.2, r: 0.8 }, CAR_TOP + 5.6, 6, P, 2, 0.3), { tone: "hi", crease: "lo" }));
  // Handle on the front face.
  out.push(S(k.slabOf({ x: 11, y: CARRIAGE.y + CARRIAGE.d - 1, w: 4, d: 4, r: 1 }, CAR_Z + 1, 3, P, 2), { tone: "mid", crease: "none" }));
  out.push(S(k.cylinder(13, CARRIAGE.y + CARRIAGE.d + 4, 3, CAR_Z, 5, P, 20), { tone: "mid" }));
  out.push(L(k.knurl(13, CARRIAGE.y + CARRIAGE.d + 4, 3, CAR_Z, CAR_Z + 5, 18, P), { tone: "lo" }));
  // The dial: minutes to the next train, one turn per ten minutes.
  const [x, y] = DIAL;
  out.push(S(k.cylinder(x, y, DIAL_R, CAR_TOP, DIAL_TOP - CAR_TOP, P, 64, 0.8), { tone: "hi", crease: "lo" }));
  out.push(L(k.knurl(x, y, DIAL_R, DIAL_TOP - 3, DIAL_TOP, 72, P, 0.3), { tone: "lo" }));
  out.push(L(k.sideArc(x, y, DIAL_R, DIAL_TOP - 3, P, 40), { tone: "faint" }));
  out.push(L(k.ring(x, y, DIAL_R - 2, DIAL_TOP, P, 64), { tone: "lo" }));
  const ticks = k.radialTicks(x, y, DIAL_R - 2.6, MINUTES_PER_TURN * 2, 2, DIAL_TOP, [1.1, 2.4], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(L(k.lineOnTop([x, y - DIAL_R + 2.6], [x, y - DIAL_R + 5.6], DIAL_TOP, P), { tone: "hi" }));
  out.push(L(k.ring(x, y, 1.4, DIAL_TOP, P, 16), { tone: "mid" }));
  out.push(S(k.slabOf({ x: x + DIAL_R - 1, y: y - 2.2, w: 4.4, d: 4.4, r: 1.1 }, CAR_TOP + 2, 4, P, 3), { tone: "mid" }));
  return out.join("");
}

const needleAt = (turn) => {
  const angle = turn * Math.PI * 2, [x, y] = DIAL;
  return k.lineOnTop([x - Math.sin(angle) * 2.6, y + Math.cos(angle) * 2.6], [x + Math.sin(angle) * (DIAL_R - 3.4), y - Math.cos(angle) * (DIAL_R - 3.4)], DIAL_TOP + 0.2, P);
};

const start = M.answer({ day: M.TODAY, live: true, minute: 3 });
const startX = CARD_X[M.TODAY];
const cards = byDepth(CARD_X.map((x, day) => [x, CARD.y, day])).map(([, , day]) => card(day));
const tape = (live) => k.wireSvg(at(TAPE_FROM), at(TAPE_TO), { via: [at([TAPE_FROM[0] + 16, TAPE_FROM[1] + 2, TAPE_FROM[2] - 1.5])], tone: live ? "hi" : "lo", flow: live, size: 1 });

const svg = k.figureSvg({
  width: WIDTH, height: HEIGHT,
  label: "A timetable rack reader on a bench plate. A rack holds nine timetable cards, one per service day from yesterday to a week ahead; today's card is lit, and a ticker tape runs onto it from a spool. A carriage on two rails carries a reading arm to whichever card is asked about, and a dial on the carriage shows the minutes to the next train. A switch on the spool's base cuts the tape.",
  body: [
    plate(), ticker(),
    `<g data-part="knob" transform="${k.translateAlong(P, [SWITCH.on, 0, 0])}">${switchKnob()}</g>`,
    trough(), ...cards,
    `<g data-part="tape">${tape(true)}</g>`,
    rails(),
    `<g data-part="carriage" transform="${k.translateAlong(P, [startX, 0, 0])}">${carriage()}<path data-part="needle" class="iso-line" data-tone="lit" data-free="start" d="${needleAt(start.wait / MINUTES_PER_TURN)}" style="stroke-width:1.1"/></g>`,
  ],
});

// Live behaviour. Pointer picks a day, a click or Space cuts the feed, the arrow keys step
// day by day, and an idle tour shows the three cases. The clock runs one train-minute per
// 1.5 s while the figure is on screen; reduced motion keeps everything still.
const live = `
const P = ${JSON.stringify(P)};
const CARD_X = ${JSON.stringify(CARD_X)}, TODAY = ${M.TODAY}, DAYS = ${M.DAYS}, HEADWAY = ${M.HEADWAY}, LATE = ${M.LATE};
const DIAL = ${JSON.stringify(DIAL)}, DIAL_R = ${DIAL_R}, DIAL_TOP = ${DIAL_TOP}, PER_TURN = ${MINUTES_PER_TURN};
const SWITCH = ${JSON.stringify(SWITCH)};
const answer = ${M.answer.toString()};
const dayName = ${M.dayName.toString()};
const readout = ${M.readout.toString()};
const needleAt = ${needleAt.toString().replace("k.lineOnTop", "lineOnTop")};
const root = document.querySelector('[data-figure="rack-reader"]');
const stage = root.querySelector(".iso-stage"), svg = stage.querySelector("svg");
const carriage = svg.querySelector('[data-part="carriage"]'), needle = svg.querySelector('[data-part="needle"]');
const knob = svg.querySelector('[data-part="knob"]'), tapeLine = svg.querySelector('[data-part="tape"] .iso-line');
const tapeWire = svg.querySelector('[data-part="tape"] .iso-wire'), out = root.querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
let day = TODAY, liveFeed = true, minute = 3, x = CARD_X[TODAY], turn = 0, knobX = SWITCH.on;
let frame = 0, last = 0, visible = false, touring = !still.matches, tourClock = 0, idle = 0;
const TOUR = [[TODAY, true, 4.5], [TODAY, false, 4], [TODAY, true, 2.5], [5, true, 4], [0, true, 3]];
const TOUR_LENGTH = TOUR.reduce((sum, step) => sum + step[2], 0);
function tourStep(t) { let at = t % TOUR_LENGTH; for (const step of TOUR) { if (at < step[2]) return step; at -= step[2]; } return TOUR[0]; }
function setFeed(on) {
  liveFeed = on;
  tapeWire.setAttribute("data-tone", on ? "hi" : "lo"); tapeLine.setAttribute("data-tone", on ? "hi" : "lo");
  if (on) tapeLine.setAttribute("data-flow", ""); else tapeLine.removeAttribute("data-flow");
}
function draw() {
  carriage.setAttribute("transform", translateAlong(P, [x, 0, 0]));
  knob.setAttribute("transform", translateAlong(P, [knobX, 0, 0]));
  needle.setAttribute("d", needleAt(turn));
  const now = answer({ day, live: liveFeed, minute });
  const text = readout(now);
  if (out.textContent !== text) { out.textContent = text; stage.setAttribute("aria-valuetext", text); stage.setAttribute("aria-valuenow", String(day)); }
}
function tick(time) {
  const dt = last ? Math.min((time - last) / 1000, 1 / 30) : 1 / 60;
  last = time;
  const calm = still.matches;
  if (touring) { tourClock += dt; const [d, on] = tourStep(tourClock); day = d; if (on !== liveFeed) setFeed(on); }
  if (!calm) minute = (minute + dt / 1.5) % 60;
  const ease = (from, to, seconds) => calm ? to : from + (to - from) * (1 - Math.exp(-dt / seconds));
  x = ease(x, CARD_X[day], 0.32); if (Math.abs(x - CARD_X[day]) < 0.02) x = CARD_X[day];
  knobX = ease(knobX, liveFeed ? SWITCH.on : SWITCH.off, 0.12);
  const now = answer({ day, live: liveFeed, minute });
  // The needle follows the wait, but never spins backwards through zero when a train leaves.
  const want = now.wait / PER_TURN;
  turn = Math.abs(want - turn) > 0.5 ? want : ease(turn, want, 0.18);
  draw();
  frame = visible && !(calm && !touring) ? requestAnimationFrame(tick) : 0;
}
const run = () => { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } };
const hold = () => { touring = false; clearTimeout(idle); idle = setTimeout(() => { touring = !still.matches; run(); }, 5000); run(); };
new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(stage);
stage.addEventListener("pointermove", (event) => {
  const box = svg.getBoundingClientRect();
  const share = clamp(((event.clientX - box.left) / box.width - 0.2) / 0.62, 0, 0.999);
  day = Math.floor(share * DAYS); hold();
});
stage.addEventListener("click", () => { setFeed(!liveFeed); hold(); });
stage.addEventListener("keydown", (event) => {
  if (event.key === " " || event.key === "Enter") { event.preventDefault(); setFeed(!liveFeed); hold(); return; }
  const to = { ArrowRight: day + 1, ArrowUp: day + 1, ArrowLeft: day - 1, ArrowDown: day - 1, Home: TODAY, End: DAYS - 1 }[event.key];
  if (to === undefined) return;
  event.preventDefault(); day = clamp(to, 0, DAYS - 1); hold();
});
draw();
if (still.matches) { touring = false; }
`;

const plate_ = (body) => k.plateHtml({
  fig: "Fig 1",
  title: "Timetable rack reader",
  hint: "Pick a day · click to cut the feed",
  readout: M.readout(start),
  keys: [
    { mark: "lit", label: "Today's card: the only one live data touches" },
    { mark: "raised", label: "Nine days of timetable, built ahead" },
    { mark: "dotted", label: `Live feed, read every ${M.POLL_SECONDS} s` },
  ],
  caption: "Every answer is read off a timetable the server built before anyone asked, one card per service day, and corrected by live data where there is some. Live data only reaches trains running now, so it only touches today's card. Cut the feed and the answer falls back to the timetable, and says so: scheduled_only.",
  body: `<div class="iso-stage" tabindex="0" role="slider" aria-label="Timetable rack reader: arrow keys pick a day, Space cuts the live feed" aria-valuemin="0" aria-valuemax="${M.DAYS - 1}" aria-valuenow="${M.TODAY}">${body}</div>`,
});
const figure = (theme) => `<div class="iso" data-theme="${theme}" data-figure="rack-reader">${plate_(svg)}</div>`;

// Preview pages for checking, in both themes.
mkdirSync(join(HERE, "out"), { recursive: true });
const kit = readFileSync(join(HERE, "kit/iso-kit.mjs"), "utf8").replace(/^export /gm, "");
for (const theme of ["dark", "light"]) {
  writeFileSync(join(HERE, `out/rack-reader${theme === "light" ? "-light" : ""}.html`),
    k.pageHtml({ title: "Timetable rack reader", theme, body: figure(theme), script: kit + live }));
}

// The docs page: the kit as a cached module, the figure between its markers.
copyFileSync(join(HERE, "kit/iso-kit.mjs"), join(DOCS, "iso-kit.js"));
const page = join(DOCS, "index.html"), html = readFileSync(page, "utf8");
const START = "<!-- fig:rack-reader -->", END = "<!-- /fig:rack-reader -->";
if (html.includes(START)) {
  // The figure follows the site's theme: <html data-theme>, or the system when unset.
  const sync = `const site = document.documentElement, wrap = document.querySelector('[data-figure="rack-reader"]'), dark = matchMedia("(prefers-color-scheme: dark)");
const syncTheme = () => { wrap.dataset.theme = site.dataset.theme || (dark.matches ? "dark" : "light"); };
syncTheme(); dark.addEventListener("change", syncTheme); new MutationObserver(syncTheme).observe(site, { attributes: true, attributeFilter: ["data-theme"] });`;
  const block = `${START}\n<style>${k.ISO_CSS}</style>\n${figure("light")}\n<script type="module">import { translateAlong, lineOnTop } from "/docs/iso-kit.js";\n${sync}\n${live.replace(/<\/(script)/gi, "<\\/$1")}</script>\n${END}`;
  writeFileSync(page, html.slice(0, html.indexOf(START)) + block + html.slice(html.indexOf(END) + END.length));
  console.log("wrote the figure into public/docs/index.html");
}
console.log("wrote out/rack-reader.html and out/rack-reader-light.html");
