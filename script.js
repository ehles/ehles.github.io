// d3d4.ru: an LCD panel. Ink flows between inscriptions as the page scrolls,
// the backplane drifts behind it, and the rest is the page's own small machinery.

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const root = document.documentElement;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- Ink engine ---------- */

const CELL = parseFloat(getComputedStyle(root).getPropertyValue("--cell")) || 3;
const INK = [13, 13, 13];
const canvas = document.querySelector("[data-ink-canvas]");
const ctx = canvas.getContext("2d");
const raster = document.createElement("canvas");
const rctx = raster.getContext("2d", { willReadFrequently: true });

let cols = 0;
let rows = 0;
let image = null;
let acc = null; // where the ink is this frame
let shown = null; // what the pixels show: liquid crystal lags behind the ink

// Draw lines of text into a w×h box, one canvas pixel per LCD cell, and return the inked cells
function rasterize(lines, w, h, align) {
    raster.width = Math.max(1, w);
    raster.height = Math.max(1, h);
    rctx.font = "700 100px Unbounded";
    const metrics = lines.map((line) => rctx.measureText(line));
    const widest = Math.max(...metrics.map((m) => m.actualBoundingBoxLeft + m.actualBoundingBoxRight));
    const cap = Math.max(...metrics.map((m) => m.actualBoundingBoxAscent));
    const gap = 0.3;
    const scale = Math.min((w * 0.98) / widest, h / ((lines.length + (lines.length - 1) * gap) * cap));

    rctx.clearRect(0, 0, w, h);
    rctx.font = `700 ${100 * scale}px Unbounded`;
    rctx.textBaseline = "alphabetic";
    rctx.fillStyle = "#000";
    const capH = cap * scale;
    const block = lines.length * capH + (lines.length - 1) * gap * capH;
    const top = align === "left" ? 0 : (h - block) / 2;
    lines.forEach((line, i) => {
        const m = metrics[i];
        const lineW = (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) * scale;
        const x = (align === "left" ? 0 : (w - lineW) / 2) + m.actualBoundingBoxLeft * scale;
        rctx.fillText(line, x, top + capH + i * capH * (1 + gap));
    });

    const data = rctx.getImageData(0, 0, w, h).data;
    const xs = [];
    const ys = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 110) {
                xs.push(x);
                ys.push(y);
            }
        }
    }
    return { xs, ys };
}

// A photograph becomes ink: scaled to w×h cells and error-diffused (Floyd–Steinberg)
function rasterizePicture(img, w, h, invert) {
    raster.width = w;
    raster.height = h;
    rctx.clearRect(0, 0, w, h);
    rctx.drawImage(img, 0, 0, w, h);
    const data = rctx.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < lum.length; i++) {
        // a cut-out picture: where it is transparent, the glass shows
        const alpha = data[i * 4 + 3] / 255;
        const v = 1 - alpha * (1 - data[i * 4] / 255);
        // a negative: the picture's lifted black backdrop turns into clean glass
        lum[i] = invert ? 1 - clamp((v - 0.12) / 0.88, 0, 1) : v;
    }
    const xs = [];
    const ys = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const ink = lum[i] < 0.5;
            if (ink) {
                xs.push(x);
                ys.push(y);
            }
            const err = lum[i] - (ink ? 0 : 1);
            if (x + 1 < w) lum[i + 1] += (err * 7) / 16;
            if (y + 1 < h) {
                if (x > 0) lum[i + w - 1] += (err * 3) / 16;
                lum[i + w] += (err * 5) / 16;
                if (x + 1 < w) lum[i + w + 1] += err / 16;
            }
        }
    }
    return { xs, ys };
}

const shifted = (set, dx, dy) => ({ xs: set.xs.map((x) => x + dx), ys: set.ys.map((y) => y + dy) });

// The words then the portrait on a wide panel; the portrait above the words on a tall one
function rasterizeWithPicture(lines, img, w, h, invert) {
    const ratio = img.naturalWidth / img.naturalHeight;
    let picture;
    let words;
    if (w / h > 1.25) {
        const ph = h;
        const pw = Math.round(ph * ratio);
        const gap = Math.round(w * 0.05);
        const tw = w - pw - gap;
        const th = Math.round(h * 0.5);
        picture = shifted(rasterizePicture(img, pw, ph, invert), w - pw, 0);
        words = shifted(rasterize(lines, tw, th, "center"), 0, Math.round((h - th) / 2));
    } else {
        let ph = Math.round(h * 0.64);
        let pw = Math.round(ph * ratio);
        if (pw > w) {
            pw = w;
            ph = Math.round(pw / ratio);
        }
        const gap = Math.round(h * 0.05);
        picture = shifted(rasterizePicture(img, pw, ph, invert), Math.round((w - pw) / 2), 0);
        words = shifted(rasterize(lines, w, h - ph - gap, "center"), 0, ph + gap);
    }
    return { xs: picture.xs.concat(words.xs), ys: picture.ys.concat(words.ys), picture, words };
}

// Pair every drop of ink in A with a place in B. Column order keeps left letters flowing
// into left letters; the delay sends the flow across as a wave, the sag lets drops hang.
function makeFlow(A, B, w) {
    const order = (s) => s.xs.map((_, i) => i).sort((a, b) => s.xs[a] - s.xs[b] || s.ys[a] - s.ys[b]);
    const na = A.xs.length;
    const nb = B.xs.length;
    const n = Math.max(na, nb);
    const oa = order(A);
    const ob = order(B);
    const flow = {
        n,
        ax: new Float32Array(n),
        ay: new Float32Array(n),
        bx: new Float32Array(n),
        by: new Float32Array(n),
        delay: new Float32Array(n),
        sag: new Float32Array(n),
    };
    for (let i = 0; i < n; i++) {
        const a = oa[Math.floor((i * na) / n)];
        const b = ob[Math.floor((i * nb) / n)];
        flow.ax[i] = A.xs[a];
        flow.ay[i] = A.ys[a];
        flow.bx[i] = B.xs[b];
        flow.by[i] = B.ys[b];
        flow.delay[i] = 0.33 * (B.xs[b] / w) + 0.12 * Math.random();
        flow.sag[i] = Math.random() ** 2 * 22;
    }
    return flow;
}

// Put a still shape on the panel
function stampSet(set, ox, oy) {
    for (let i = 0; i < set.xs.length; i++) plot(ox + set.xs[i], oy + set.ys[i]);
}

const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

// Put the flow on the panel at progress t (0 = shape A, 1 = shape B), with its box at (ox, oy) cells
function stamp(flow, t, ox, oy) {
    for (let i = 0; i < flow.n; i++) {
        const e = ease(clamp((t - flow.delay[i]) / 0.55, 0, 1));
        const x = ox + flow.ax[i] + (flow.bx[i] - flow.ax[i]) * e;
        const y = oy + flow.ay[i] + (flow.by[i] - flow.ay[i]) * e + flow.sag[i] * Math.sin(Math.PI * e);
        const cx = Math.round(x);
        const cy = Math.round(y);
        if (cx < 0 || cy < 0 || cx >= cols - 1 || cy >= rows - 1) continue;
        const cell = cy * cols + cx;
        acc[cell] = 1;
        // a drop in flight is a little blob, not a single grain
        if (e > 0 && e < 1) {
            acc[cell + 1] = 1;
            acc[cell + cols] = 1;
        }
    }
}

// The shadow falls one cell right and, like a view through glass at an angle,
// further down the lower it sits on the panel: that difference is the parallax.
const shadowRows = (y) => Math.round(1 + (y / rows - 0.5) * 2);

function paint() {
    const decay = reduceMotion ? 0 : 0.8;
    let settling = false;
    for (let i = 0; i < shown.length; i++) {
        const faded = shown[i] * decay;
        if (faded > acc[i] && faded > 0.03) {
            shown[i] = faded;
            settling = true;
        } else {
            shown[i] = acc[i];
        }
    }
    const px = image.data;
    for (let y = 0; y < rows; y++) {
        const sy = y - shadowRows(y);
        for (let x = 0; x < cols; x++) {
            const i = y * cols + x;
            const ink = shown[i];
            const shade = sy >= 0 && x > 0 ? shown[sy * cols + x - 1] * 0.15 : 0;
            const p = i * 4;
            px[p] = INK[0];
            px[p + 1] = INK[1];
            px[p + 2] = INK[2];
            px[p + 3] = (ink + (1 - ink) * shade) * 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    return settling;
}

/* ---------- What the panel shows ---------- */

const intro = document.querySelector("[data-intro]");
const display = document.querySelector("[data-display]");
const phraseItems = [...document.querySelectorAll("[data-phrases] li")];
const caption = document.querySelector("[data-caption]");
const count = document.querySelector("[data-count]");
const titles = [...document.querySelectorAll("[data-ink]")].map((el) => ({ el, flow: null }));
const pictures = new Map(); // phrase → loaded portrait
let introSets = [];
let introFlows = [];
let lastPhrase = -1;
let morph = null; // the ink flowing from one language's words into the other's

function build() {
    cols = Math.ceil(window.innerWidth / CELL);
    rows = Math.ceil(window.innerHeight / CELL) + 1;
    canvas.width = cols;
    canvas.height = rows;
    canvas.style.width = `${cols * CELL}px`;
    canvas.style.height = `${rows * CELL}px`;
    image = ctx.createImageData(cols, rows);
    acc = new Float32Array(cols * rows);
    shown = new Float32Array(cols * rows);

    const box = display.getBoundingClientRect();
    const w = Math.floor(box.width / CELL);
    const h = Math.floor(box.height / CELL);
    introSets = phraseItems.map((li) => {
        const lines = ((lang === "ru" && li.dataset.linesRu) || li.dataset.lines).split("|");
        const picture = pictures.get(li);
        return picture
            ? rasterizeWithPicture(lines, picture, w, h, "invert" in li.dataset)
            : rasterize(lines, w, h, "center");
    });
    introFlows = introSets.slice(1).map((set, i) => makeFlow(introSets[i], set, w));
    vapourPhrase = phraseItems.findIndex((li, i) => "vapour" in li.dataset && introSets[i].picture);
    if (vapourPhrase >= 0) setVapourSource(introSets[vapourPhrase].picture);

    for (const title of titles) {
        const r = title.el.getBoundingClientRect();
        const tw = Math.floor(r.width / CELL);
        const th = Math.floor(r.height / CELL);
        const shape = rasterize([title.el.textContent.trim().toUpperCase()], tw, th, "left");
        title.shape = shape;
        // the ink waits in a pool below the start of the heading and rises into the letters
        const pool = {
            xs: shape.xs.map((x) => Math.round(x * 0.12)),
            ys: shape.ys.map(() => th + 4 + Math.round(Math.random() * 5)),
        };
        title.flow = makeFlow(pool, shape, tw);
    }
}

function stampIntro() {
    const r = intro.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    const steps = introFlows.length;
    const p = clamp(-r.top / (r.height - window.innerHeight), 0, 1) * steps;
    const k = Math.min(Math.floor(p), steps - 1);
    let t = clamp((p - k - 0.3) / 0.45, 0, 1);
    if (reduceMotion) t = t < 0.5 ? 0 : 1;
    const d = display.getBoundingClientRect();
    const ox = Math.round(d.left / CELL);
    const oy = Math.round(d.top / CELL);
    const resting = t === 0 || t === 1;
    const current = k + (t >= 0.5 ? 1 : 0);
    if (morph && resting && current === morph.phrase) {
        // the picture stays put while the words around it change language
        if (morph.picture) stampSet(morph.picture, ox, oy);
        stamp(morph.intro, morph.t, ox, oy);
    } else {
        stamp(introFlows[k], t, ox, oy);
    }

    // the portrait evaporates only while it stands whole on the panel
    let strength = 0;
    if (k === vapourPhrase) strength = 1 - t * 3;
    else if (k + 1 === vapourPhrase) strength = t * 3 - 2;
    if (!reduceMotion && strength > 0) {
        stepVapour(ox, oy, clamp(strength, 0, 1));
        ambient = true;
    } else {
        resetVapour();
    }

    if (current !== lastPhrase) {
        lastPhrase = current;
        caption.textContent = phraseItems[current].textContent;
        count.textContent = current + 1;
    }
}

function stampTitles() {
    const vh = window.innerHeight;
    for (const title of titles) {
        const r = title.el.getBoundingClientRect();
        if (r.bottom < -40 || r.top > vh + 40) continue;
        const t = reduceMotion ? 1 : clamp((vh * 0.98 - r.top) / (vh * 0.45), 0, 1);
        const ox = Math.round(r.left / CELL);
        const oy = Math.round(r.top / CELL);
        const switching = morph && morph.titles.get(title);
        if (switching && t === 1) stamp(switching, morph.t, ox, oy);
        // the pool stays dry until the heading starts to fill
        else if (t > 0) stamp(title.flow, t, ox, oy);
    }
}

/* ---------- Vapour: the figure dissolves into pixels, and the pixels turn into code ---------- */

// A 3×5 dot-matrix font, rows top to bottom, just the characters the code fragments need
const GLYPHS = {
    0: "###,#.#,#.#,#.#,###", 1: ".#.,##.,.#.,.#.,###", 2: "###,..#,###,#..,###", 3: "###,..#,.##,..#,###",
    4: "#.#,#.#,###,..#,..#", 5: "###,#..,###,..#,###", 6: "###,#..,###,#.#,###", 7: "###,..#,.#.,.#.,.#.",
    8: "###,#.#,###,#.#,###", 9: "###,#.#,###,..#,###", A: ".#.,#.#,###,#.#,#.#", B: "##.,#.#,##.,#.#,##.",
    C: "###,#..,#..,#..,###", D: "##.,#.#,#.#,#.#,##.", E: "###,#..,##.,#..,###", F: "###,#..,##.,#..,#..",
    G: "###,#..,#.#,#.#,###", H: "#.#,#.#,###,#.#,#.#", I: "###,.#.,.#.,.#.,###", K: "#.#,##.,#..,##.,#.#",
    L: "#..,#..,#..,#..,###", N: "##.,#.#,#.#,#.#,#.#", O: "###,#.#,#.#,#.#,###", P: "###,#.#,###,#..,#..",
    R: "##.,#.#,##.,#.#,#.#", S: "###,#..,###,..#,###", T: "###,.#.,.#.,.#.,.#.", X: "#.#,#.#,.#.,#.#,#.#",
    Y: "#.#,#.#,.#.,.#.,.#.", "{": ".##,.#.,##.,.#.,.##", "}": "##.,.#.,.##,.#.,##.", "(": ".#.,#..,#..,#..,.#.",
    ")": ".#.,..#,..#,..#,.#.", "[": "##.,#..,#..,#..,##.", "]": ".##,..#,..#,..#,.##", ";": "...,.#.,...,.#.,#..",
    "=": "...,###,...,###,...", ">": "#..,.#.,..#,.#.,#..", "<": "..#,.#.,#..,.#.,..#", "/": "..#,..#,.#.,#..,#..",
    "&": ".#.,#.#,.#.,#.#,.##", "*": "...,#.#,.#.,#.#,...", "+": "...,.#.,###,.#.,...", "!": ".#.,.#.,.#.,...,.#.",
};

// What a person turns into, if he writes code: bits, hex, and the words of his trade
const TOKENS = [
    "0", "1", "0", "1", "1", "0", "0X", "D3", "D4", "FF", "{}", "()", "[]", ";", "=>", "&&", "!=", "//",
    "GO", "PY", "IF", "FN", "NIL", "SIP", "RTP", "TCP", "S3", "OK", "0X1F", "<>",
].map((token) => {
    const cells = [];
    [...token].forEach((ch, k) => {
        GLYPHS[ch].split(",").forEach((row, y) => {
            [...row].forEach((c, x) => {
                if (c === "#") cells.push(k * 4 + x, y);
            });
        });
    });
    return Int8Array.from(cells);
});

// A fixed pseudo-random number per particle and cell, so a glyph builds and breaks up
// in a steady order instead of flickering
const hash = (a, b) => {
    const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return h - Math.floor(h);
};

const VAPOUR_MAX = 6000;
const vapour = {
    n: 0,
    x: new Float32Array(VAPOUR_MAX),
    y: new Float32Array(VAPOUR_MAX),
    vx: new Float32Array(VAPOUR_MAX),
    vy: new Float32Array(VAPOUR_MAX),
    age: new Float32Array(VAPOUR_MAX),
    life: new Float32Array(VAPOUR_MAX),
    token: new Int16Array(VAPOUR_MAX), // -1: stays a plain pixel
    seed: new Float32Array(VAPOUR_MAX),
};
const VAPOUR_KEYS = Object.keys(vapour).filter((key) => key !== "n");
let vapourPhrase = -1;
let source = null; // the portrait's cells, how eager each is to leave, and until when it is gone
let tick = 0;

function setVapourSource(picture) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    picture.xs.forEach((x, i) => {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, picture.ys[i]);
        maxY = Math.max(maxY, picture.ys[i]);
    });
    // the left half holds; the right half gives itself up, more and more towards the edge
    const mid = (minX + maxX) / 2;
    const eager = picture.xs.map((x) => (x > mid ? ((x - mid) / (maxX - mid)) ** 1.6 : 0));
    source = {
        xs: picture.xs,
        ys: picture.ys,
        eager,
        goneUntil: new Float32Array(picture.xs.length),
        // code is born from the head and shoulders, so it has clear glass to rise into
        codeBelow: minY + (maxY - minY) * 0.55,
    };
    vapour.n = 0;
}

function resetVapour() {
    if (source) source.goneUntil.fill(0);
    vapour.n = 0;
}

const plot = (x, y) => {
    if (x >= 0 && y >= 0 && x < cols && y < rows) acc[y * cols + x] = 1;
};

function stepVapour(ox, oy, strength) {
    const v = vapour;
    if (!source || !source.xs.length) return;
    tick += 1;

    // each frame a share of the figure lets go; a pixel stays gone for a few seconds,
    // so the holes pile up into a figure that is visibly coming apart
    const attempts = Math.round(source.xs.length * 0.014 * strength);
    for (let a = 0; a < attempts; a++) {
        const pick = Math.floor(Math.random() * source.xs.length);
        if (source.goneUntil[pick] > tick || Math.random() > source.eager[pick]) continue;
        source.goneUntil[pick] = tick + 90 + Math.random() * 240;
        if (v.n >= VAPOUR_MAX) continue;
        const i = v.n++;
        // some pixels grow into a piece of code on their way out. Code drifts slowly, a cell
        // every seven frames or so, so the panel's afterglow does not smear the glyph
        const isCode = source.ys[pick] < source.codeBelow && Math.random() < 0.05;
        v.x[i] = source.xs[pick];
        v.y[i] = source.ys[pick];
        // code rises almost straight up, into the clear glass above the figure
        v.vx[i] = isCode ? -0.07 + Math.random() * 0.16 : 0.08 + Math.random() * 0.27;
        v.vy[i] = isCode ? -(0.11 + Math.random() * 0.06) : -(0.04 + Math.random() * 0.2);
        v.age[i] = 0;
        v.life[i] = isCode ? 420 + Math.random() * 240 : 80 + Math.random() * 140;
        v.token[i] = isCode ? Math.floor(Math.random() * TOKENS.length) : -1;
        v.seed[i] = Math.random() * 1000;
    }

    // the holes the figure has lost
    for (let i = 0; i < source.xs.length; i++) {
        if (source.goneUntil[i] <= tick) continue;
        const hx = ox + source.xs[i];
        const hy = oy + source.ys[i];
        if (hx >= 0 && hy >= 0 && hx < cols && hy < rows) acc[hy * cols + hx] = 0;
    }

    // the pixels in flight: plain ones thin out as they rise, the others become code
    for (let i = 0; i < v.n; i++) {
        v.age[i] += 1;
        if (v.age[i] >= v.life[i]) {
            // retire: the last particle takes this slot
            const last = --v.n;
            for (const key of VAPOUR_KEYS) v[key][i] = v[key][last];
            i--;
            continue;
        }
        if (v.token[i] < 0) {
            v.x[i] += v.vx[i] + Math.sin((v.age[i] + i) * 0.2) * 0.1;
            v.vy[i] -= 0.0025;
        } else {
            v.x[i] += v.vx[i];
        }
        v.y[i] += v.vy[i];

        const u = v.age[i] / v.life[i];
        const cx = Math.round(ox + v.x[i]);
        const cy = Math.round(oy + v.y[i]);
        if (v.token[i] < 0) {
            if (Math.random() < (1 - u) * strength) plot(cx, cy);
            continue;
        }
        // a pixel first, then the glyph assembles dot by dot, holds, and breaks up again
        if (u < 0.05) {
            plot(cx, cy);
            continue;
        }
        const built = clamp((u - 0.05) / 0.12, 0, 1);
        const kept = clamp((1 - u) / 0.3, 0, 1) * strength;
        const cells = TOKENS[v.token[i]];
        for (let c = 0; c < cells.length; c += 2) {
            if (hash(v.seed[i], c) < built && hash(c, v.seed[i]) < kept) plot(cx + cells[c], cy + cells[c + 1]);
        }
    }
}

/* ---------- Backplane, glass and shadows ---------- */

const grain = document.querySelector("[data-grain]");
const sheen = document.querySelector("[data-sheen]");
const shadowed = [...document.querySelectorAll("[data-shadow]")];

function makeGrain() {
    const tile = document.createElement("canvas");
    tile.width = tile.height = 256;
    const g = tile.getContext("2d");
    const data = g.createImageData(256, 256);
    for (let i = 0; i < data.data.length; i += 4) {
        const dark = Math.random() < 0.5;
        data.data[i] = data.data[i + 1] = data.data[i + 2] = dark ? 0 : 255;
        data.data[i + 3] = Math.random() * (dark ? 22 : 30);
    }
    g.putImageData(data, 0, 0);
    grain.style.backgroundImage = `url(${tile.toDataURL()})`;
}

function parallax() {
    const y = window.scrollY;
    const vh = window.innerHeight;
    if (!reduceMotion) {
        grain.style.transform = `translate3d(0, ${-((y * 0.15) % 256)}px, 0)`;
        sheen.style.transform = `translate3d(0, ${Math.sin(y / 1400) * vh * 0.22}px, 0)`;
    }
    // printed text gets the same view-angle shadow as the ink on the canvas
    for (const el of shadowed) {
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh) continue;
        const centre = clamp((r.top + Math.min(r.height, vh) / 2) / vh, 0, 1);
        el.style.setProperty("--shy", `${(1 + (centre - 0.5) * 1.2) * CELL}px`);
    }
}

/* ---------- Frame loop ---------- */

let running = false;
let ambient = false; // something on the panel moves by itself this frame

const MORPH_MS = 1300;

function frame(now) {
    acc.fill(0);
    ambient = false;
    if (morph) {
        morph.t = clamp((now - morph.start) / MORPH_MS, 0, 1);
        if (morph.t >= 1) morph = null;
        else ambient = true;
    }
    stampIntro();
    stampTitles();
    const settling = paint();
    parallax();
    if (settling || ambient) requestAnimationFrame(frame);
    else running = false;
}

function kick() {
    if (running || !image) return;
    running = true;
    requestAnimationFrame(frame);
}

async function startPanel() {
    makeGrain();
    try {
        await document.fonts.load("700 100px Unbounded", lang === "ru" ? "ДЕНИС 0xD3D4" : "DENIS 0xD3D4");
    } catch {
        // draw with the fallback face
    }
    await Promise.all(
        phraseItems
            .filter((li) => li.dataset.picture)
            .map(async (li) => {
                const img = new Image();
                img.src = li.dataset.picture;
                try {
                    await img.decode();
                    pictures.set(li, img);
                } catch {
                    // the phrase is drawn without its picture
                }
            }),
    );
    build();
    root.classList.add("lcd-ready");
    kick();
    window.addEventListener("scroll", kick, { passive: true });
    setupSnap();
    let resizeTimer = 0;
    let lastWidth = window.innerWidth;
    window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            // phones change height when the address bar slides; only rebuild when it matters
            if (window.innerWidth === lastWidth && Math.abs(window.innerHeight - rows * CELL) < 120) return kick();
            lastWidth = window.innerWidth;
            build();
            kick();
        }, 150);
    });
}

/* ---------- Snap: the intro never rests between two phrases ---------- */

// Where the intro is, in phrases: 2 means the third phrase stands whole, 2.4 is mid-flow
function introPosition() {
    const r = intro.getBoundingClientRect();
    const steps = phraseItems.length - 1;
    const step = (r.height - window.innerHeight) / steps;
    return { p: -r.top / step, steps, step, top: window.scrollY + r.top };
}

// The flow between two phrases plays from 0.3 to 0.75 of a step; past its middle,
// the next phrase is the nearer one
const FLOW_MIDDLE = 0.525;
const easeOut = (u) => 1 - (1 - u) ** 4;

// When the scroll comes to rest halfway through a flow, the nearer phrase pulls it in:
// quick at first, slowing as it lands
function setupSnap() {
    let touching = false;
    let settleTimer = 0;
    let glide = 0; // the frame of the pull in progress

    function stop() {
        cancelAnimationFrame(glide);
        glide = 0;
    }

    function pull(to) {
        const from = window.scrollY;
        const distance = to - from;
        // a longer way takes a little longer, never so long it feels sluggish
        const duration = clamp(650 + Math.abs(distance) * 1.4, 750, 1300);
        const start = performance.now();
        const step = (now) => {
            const u = clamp((now - start) / duration, 0, 1);
            window.scrollTo({ top: from + distance * easeOut(u), behavior: "instant" });
            glide = u < 1 ? requestAnimationFrame(step) : 0;
        };
        glide = requestAnimationFrame(step);
    }

    function settle() {
        if (touching || glide) return;
        const { p, steps, step, top } = introPosition();
        const k = Math.floor(p);
        // a phrase stands whole for a little while either side of its spot
        if (p <= 0 || p >= steps || Math.abs(p - Math.round(p)) < 0.04) return;
        const target = top + (p - k > FLOW_MIDDLE ? k + 1 : k) * step;
        if (reduceMotion) window.scrollTo({ top: target, behavior: "instant" });
        else pull(target);
    }

    const schedule = () => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(settle, 260);
    };
    // a hand on the page takes over from the pull
    const grab = () => {
        stop();
        clearTimeout(settleTimer);
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("wheel", grab, { passive: true });
    window.addEventListener("touchstart", () => {
        touching = true;
        grab();
    }, { passive: true });
    window.addEventListener("touchend", () => {
        touching = false;
        schedule();
    }, { passive: true });
    window.addEventListener("touchcancel", () => {
        touching = false;
        schedule();
    }, { passive: true });
}

/* ---------- Language: English or Russian, remembered per visitor ---------- */

const META = {
    en: { title: document.title, description: document.querySelector('meta[name="description"]').content },
    ru: {
        title: "Денис · 0xD3D4",
        description:
            "Денис (0xD3D4), разработчик ПО из Нижнего Новгорода: системы хранения, сети, телеком и безопасность. Автор HamTutor, приложения для подготовки к экзамену на радиолюбительскую категорию.",
    },
};
const translated = [...document.querySelectorAll("[data-ru]")];
const labelled = [...document.querySelectorAll("[data-ru-label]")];
const langButtons = [...document.querySelectorAll("[data-lang]")];
translated.forEach((el) => (el.dataset.en = el.textContent.trim()));
labelled.forEach((el) => (el.dataset.enLabel = el.getAttribute("aria-label")));
let lang = "en";

function pickLanguage() {
    try {
        const saved = localStorage.getItem("lang");
        if (saved === "en" || saved === "ru") return saved;
    } catch {
        // storage blocked: fall back to the browser's languages
    }
    return (navigator.languages || [navigator.language]).some((l) => /^ru\b/i.test(l)) ? "ru" : "en";
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
let switching = Promise.resolve();

async function setLanguage(next) {
    const animate = Boolean(image) && !reduceMotion && next !== lang;
    if (animate) {
        root.classList.remove("lang-in");
        root.classList.add("lang-out");
        await wait(180);
    }
    lang = next;
    for (const el of translated) el.textContent = lang === "ru" ? el.dataset.ru : el.dataset.en;
    for (const el of labelled) el.setAttribute("aria-label", lang === "ru" ? el.dataset.ruLabel : el.dataset.enLabel);
    root.lang = lang;
    document.title = META[lang].title;
    document.querySelector('meta[name="description"]').content = META[lang].description;
    langButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
    try {
        localStorage.setItem("lang", lang);
    } catch {
        // the choice just will not be remembered
    }
    // the ink is drawn from the words, so redraw it in the new language
    if (image) {
        try {
            await document.fonts.load("700 100px Unbounded", "ДЕНИС");
        } catch {
            // draw with what has loaded
        }
        const before = { phrase: lastPhrase, sets: introSets, titles: titles.map((t) => t.shape) };
        build();
        lastPhrase = -1;
        if (animate) startMorph(before);
        kick();
    }
    if (animate) {
        root.classList.replace("lang-out", "lang-in");
        await wait(360);
        root.classList.remove("lang-in");
    }
}

// The ink of the words on screen flows into the same words in the other language
function startMorph(before) {
    const w = Math.floor(display.getBoundingClientRect().width / CELL);
    const from = before.sets[before.phrase];
    const to = introSets[before.phrase];
    morph = { start: performance.now(), t: 0, phrase: before.phrase, picture: null, intro: null, titles: new Map() };
    if (from && to) {
        morph.picture = to.picture || null;
        morph.intro = makeFlow(from.words || from, to.words || to, w);
    } else {
        morph.phrase = -1;
    }
    titles.forEach((title, i) => {
        const old = before.titles[i];
        if (old && old.xs.length && title.shape.xs.length) {
            morph.titles.set(title, makeFlow(old, title.shape, Math.floor(title.el.getBoundingClientRect().width / CELL)));
        }
    });
}

// one switch at a time, so a double tap does not tangle two sweeps
langButtons.forEach((b) =>
    b.addEventListener("click", () => {
        switching = switching.then(() => setLanguage(b.dataset.lang));
    }),
);

/* ---------- Page machinery ---------- */

// Real questions from «Радиолюбительский экзамен»; the first one is already in the HTML
const questions = [
    {
        n: 12,
        q: "Какой из перечисленных позывных сигналов образован для любительской службы?",
        options: ["RA9EM", "RMT", "MO13", "ФОНАРЬ"],
        correct: 0,
    },
    {
        n: 10,
        q: "На основании рекомендаций какой организации в различных странах Европы и ряде неевропейских стран устанавливаются единые требования к квалификации радиолюбителей?",
        options: [
            "СРР (Союз радиолюбителей России)",
            "CEPT (Европейская конференция администраций почт и электросвязи)",
            "WRL (Всемирная радиолюбительская лига)",
            "ITU (МСЭ, Международный союз электросвязи)",
        ],
        correct: 1,
    },
    {
        n: 5,
        q: "Как называется станция любительской службы, производящая односторонние передачи в целях изучения условий распространения радиоволн?",
        options: ["Радиомаяк", "Ретранслятор", "Станция радиоуправления", "Цифровая станция"],
        correct: 0,
    },
];

function setupQuiz() {
    const quiz = document.querySelector("[data-quiz]");
    const qEl = quiz.querySelector("[data-q]");
    const num = quiz.querySelector("[data-qnum]");
    const list = quiz.querySelector("[data-options]");
    const result = quiz.querySelector("[data-result]");
    const next = quiz.querySelector("[data-next]");
    let index = 0;

    function render() {
        const item = questions[index];
        qEl.textContent = item.q;
        num.textContent = item.n;
        list.replaceChildren(
            ...item.options.map((text, i) => {
                const li = document.createElement("li");
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = text;
                if (i === item.correct) button.dataset.correct = "";
                li.append(button);
                return li;
            }),
        );
        result.textContent = "Выберите ответ.";
        next.hidden = true;
    }

    list.addEventListener("click", (event) => {
        const picked = event.target.closest("button");
        if (!picked || picked.disabled) return;
        const buttons = [...list.querySelectorAll("button")];
        const right = buttons.find((b) => "correct" in b.dataset);
        buttons.forEach((b) => (b.disabled = true));
        right.classList.add("is-right");
        if (picked === right) {
            result.textContent = "Верно. В приложении таких вопросов больше четырёхсот.";
        } else {
            picked.classList.add("is-wrong");
            result.textContent = `Нет. Правильный ответ: ${right.textContent}.`;
        }
        next.hidden = false;
    });

    next.addEventListener("click", () => {
        index = (index + 1) % questions.length;
        render();
        list.querySelector("button").focus();
    });
}

// 0xD3D4 → decimal → binary, one step per press
function setupHex() {
    const button = document.querySelector("[data-hex]");
    const forms = ["0xD3D4", "54228", "1101 0011 1101 0100"];
    let i = 0;
    button.addEventListener("click", () => {
        i = (i + 1) % forms.length;
        button.textContent = forms[i];
    });
}

// Nizhny Novgorod keeps Moscow time
function setupClock() {
    const short = document.querySelector("[data-clock]");
    const long = document.querySelector("[data-clock-long]");
    const hm = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" });
    const hms = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    function tick() {
        const now = new Date();
        short.textContent = `NN ${hm.format(now)}`;
        long.textContent = `${hms.format(now)} UTC+3`;
    }
    tick();
    setInterval(tick, 1000);
}

setLanguage(pickLanguage());
setupQuiz();
setupHex();
setupClock();
startPanel();
