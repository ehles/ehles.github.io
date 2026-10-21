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
let introFlows = [];
let lastPhrase = -1;

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
    const sets = phraseItems.map((li) => rasterize(li.dataset.lines.split("|"), w, h, "center"));
    introFlows = sets.slice(1).map((set, i) => makeFlow(sets[i], set, w));

    for (const title of titles) {
        const r = title.el.getBoundingClientRect();
        const tw = Math.floor(r.width / CELL);
        const th = Math.floor(r.height / CELL);
        const shape = rasterize([title.el.textContent.trim().toUpperCase()], tw, th, "left");
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
    stamp(introFlows[k], t, Math.round(d.left / CELL), Math.round(d.top / CELL));

    const current = k + (t >= 0.5 ? 1 : 0);
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
        // the pool stays dry until the heading starts to fill
        if (t > 0) stamp(title.flow, t, Math.round(r.left / CELL), Math.round(r.top / CELL));
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

function frame() {
    acc.fill(0);
    stampIntro();
    stampTitles();
    const settling = paint();
    parallax();
    if (settling) requestAnimationFrame(frame);
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
        await document.fonts.load("700 100px Unbounded");
    } catch {
        // draw with the fallback face
    }
    build();
    root.classList.add("lcd-ready");
    kick();
    window.addEventListener("scroll", kick, { passive: true });
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

// 0xd3d4 → decimal → binary, one step per press
function setupHex() {
    const button = document.querySelector("[data-hex]");
    const forms = ["0xd3d4", "54228", "1101 0011 1101 0100"];
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

// Replace the baked-in list with the live one from GitHub; keep the static one on any failure
async function setupRepos() {
    const list = document.querySelector("[data-repos]");
    try {
        const response = await fetch("https://api.github.com/users/ehles/repos?sort=pushed&per_page=100");
        if (!response.ok) return;
        const repos = (await response.json()).filter((r) => !r.fork && r.name !== "ehles" && r.name !== "tests");
        if (!repos.length) return;
        const app = list.firstElementChild; // the RuStore app stays first
        const items = repos.map((repo) => {
            const li = document.createElement("li");
            const a = document.createElement("a");
            a.href = repo.html_url;
            if (repo.description) a.title = repo.description;
            for (const text of [repo.name, repo.language || "Misc", repo.pushed_at.slice(0, 4)]) {
                const span = document.createElement("span");
                span.textContent = text;
                a.append(span);
            }
            li.append(a);
            return li;
        });
        list.replaceChildren(app, ...items);
        kick();
    } catch {
        // offline or rate-limited: the static list is already there
    }
}

setupQuiz();
setupHex();
setupClock();
setupRepos();
startPanel();
