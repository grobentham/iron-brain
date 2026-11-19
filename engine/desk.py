"""Iron Brain intraday desk: walk-forward tested session statistics for NQ and gold futures.

History comes from Displace's bar archive (grobentham/displace engine/cache/bars, Yahoo futures bars that grow every
run); the latest bars come straight from Yahoo. Everything is free and needs no key.

A trading day runs from 18:00 to 17:00 New York time (23 hourly slots); the account it is fitted to (see account.py)
is flattened at 16:10, so the horizon ends with the 15:00-16:00 bar. For every hour of every day the engine asks:
from this close, how far did price travel up and down before 16:00, as a share of the range expected for the rest of the
day (the day's typical range, scaled by how much of a day's movement is still to come)? The answers become the touch odds the page shows for any price and time, and every one of them is
scored on days the model had not seen.

Tests (all walk-forward, refit every 20 days on earlier days only):
  touch     P(trading k x the expected remaining range above/below the price before 16:00), k = 1/4 .. 1
  extreme   P(a new high / new low before 16:00) vs the plain rate for that hour
  by hour   whether each hour needs its own distribution (late in the day moves fall short of a shared one)
  pace      whether today's range so far (fast or slow day) changes those odds; used only if it passes
  hours     whether any hour of the day closes up more often than chance (Bonferroni across hours and markets)
  opening   09:30-10:00 opening range statistics from 5-minute bars (collecting until enough days exist)
"""
import datetime as dt
import json
import math
import os
import sys
import time
import urllib.request
from statistics import NormalDist
from zoneinfo import ZoneInfo

import numpy as np

NY = ZoneInfo("America/New_York")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "site", "data", "desk.json")
ARCHIVE = "https://raw.githubusercontent.com/grobentham/displace/main/engine/cache/bars/{m}_{iv}.json"
DAILY = "https://raw.githubusercontent.com/grobentham/displace/main/engine/cache/daily/{m}.json"
YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/{s}?range={r}&interval={iv}"
UA = {"User-Agent": "Mozilla/5.0 (Iron Brain intraday desk; +https://github.com/grobentham/iron-brain)"}
MARKETS = {
    "nq": {"symbol": "NQ%3DF", "name": "NQ", "full": "E-mini Nasdaq-100 futures", "tick": 0.25, "pv": 20, "micro": 2,
           "dp": 2},
    "gold": {"symbol": "GC%3DF", "name": "Gold", "full": "COMEX gold futures", "tick": 0.1, "pv": 100, "micro": 10,
             "dp": 1},
}
SLOTS = 23                      # 18:00 ... 16:00 bar starts
SLOT_HOURS = [(18 + j) % 24 for j in range(SLOTS)]
# MyFundedFutures flattens every account at 16:10 New York, so the trading horizon ends with the 15:00-16:00 bar
LAST = SLOT_HOURS.index(15)
KS = (0.25, 0.5, 0.75, 1.0)  # fractions of the expected remaining range
BETAS = (0.0, 0.25, 0.5, 0.75, 1.0)
GRID = np.round(np.arange(0, 5.001, 0.02), 2)
WARM, STEP, SPAN = 150, 20, 20
MIN_OR_DAYS = 250
NEIGHBOURS = 1                # hours either side pooled into each hour's distribution


# ---------- data ----------

def _get(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                return json.load(r)
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(3 * (i + 1))


def yahoo(symbol, interval, rng):
    res = _get(YAHOO.format(s=symbol, r=rng, iv=interval))["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    out = {}
    for t, o, h, lo, c in zip(res["timestamp"], q["open"], q["high"], q["low"], q["close"]):
        if o and h and lo and c:
            out[dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat(timespec="minutes")] = [o, h, lo, c]
    return out


def load_bars(m, interval, source=None, fresh=True, log=print):
    """{iso utc: [o,h,l,c]}: Displace's archive, topped up with Yahoo's latest bars."""
    bars = {}
    try:
        if source:
            bars = json.load(open(os.path.join(source, f"{m}_{interval}.json")))["bars"]
        else:
            bars = _get(ARCHIVE.format(m=m, iv=interval))["bars"]
    except Exception as e:
        log(f"desk: {m} {interval} archive unavailable ({e!r})")
    if fresh:
        try:
            bars.update(yahoo(MARKETS[m]["symbol"], interval, "5d"))
        except Exception as e:
            log(f"desk: {m} {interval} latest bars unavailable ({e!r})")
    return {k: v[:4] for k, v in bars.items()}


def load_daily(m, source=None, log=print):
    """{date: [o,h,l,c]} daily futures candles since 2000 from Displace's archive."""
    try:
        if source:
            return json.load(open(os.path.join(source, "daily", f"{m}.json")))["days"]
        return _get(DAILY.format(m=m))["days"]
    except Exception as e:
        log(f"desk: {m} daily archive unavailable ({e!r})")
        return {}


def to_ny(bars):
    rows = []
    for t, v in sorted(bars.items()):
        o, h, lo, c = v
        if not (h >= lo > 0 and h >= max(o, c) - 1e-9 and lo <= min(o, c) + 1e-9) or h <= lo:
            continue
        rows.append((dt.datetime.fromisoformat(t).astimezone(NY), o, h, lo, c))
    return rows


def day_key(t):
    return (t + dt.timedelta(hours=6)).date()


def hourly_days(rows):
    """Complete trading days: (date, O, H, L, C) arrays of 23 hourly slots."""
    days = {}
    for t, o, h, lo, c in rows:
        if t.minute != 0 or t.hour == 17:
            continue
        j = (t.hour - 18) % 24
        days.setdefault(day_key(t), {})[j] = (o, h, lo, c)
    out = []
    for d in sorted(days):
        s = days[d]
        if len(s) == SLOTS and d.weekday() < 5:
            a = np.array([s[j] for j in range(SLOTS)], dtype=float)
            out.append((d, a[:, 0], a[:, 1], a[:, 2], a[:, 3]))
    return out


# ---------- model pieces ----------

def scales(days):
    """EWMA of the daily log range known before each day (None during warm-up)."""
    R = np.array([math.log(H.max() / L.min()) for _, _, H, L, _ in days])
    s, out, a = None, [], 2 / (SPAN + 1)
    for i, r in enumerate(R):
        out.append(s)
        if i + 1 == SPAN:
            s = float(np.sqrt(np.mean(R[:SPAN] ** 2)))
        elif s is not None:
            s = math.sqrt(a * r * r + (1 - a) * s * s)
    return R, out


def profile(days, idx):
    """Share of a day's variance that each hourly slot carries (fitted on the given days)."""
    hr = np.array([[math.log(h / l) ** 2 for h, l in zip(days[i][2], days[i][3])] for i in idx])
    w = hr.mean(axis=0)
    return w / w.sum()


def checkpoints(days, s, w, idx):
    """One row per (day, hour): excursions after the hour in remaining-sigma units, plus context."""
    cum = np.cumsum(w)
    rows = []
    for di in idx:
        d, O, H, L, C = days[di]
        if s[di] is None:
            continue
        for i in range(LAST):
            rem = math.sqrt(max(1e-9, cum[LAST] - cum[i])) * s[di]
            done = math.sqrt(cum[i]) * s[di]
            c = C[i]
            hs, ls = H[: i + 1].max(), L[: i + 1].min()
            up = max(0.0, math.log(H[i + 1:LAST + 1].max() / c)) / rem
            dn = max(0.0, math.log(c / L[i + 1:LAST + 1].min())) / rem
            rho = max(0.05, math.log(hs / ls) / done)
            rows.append((di, i, up, dn, math.log(hs / c) / rem, math.log(c / ls) / rem, rho))
    return np.array(rows, dtype=float).reshape(-1, 7)


def survival(e):
    e = np.sort(e)
    n = len(e)
    return lambda x: (n - np.searchsorted(e, x, side="left") + 0.5) / (n + 1)


def _cols(Su, Sd, test, rs):
    cols = []
    for k in KS:
        cols.append(Su(k / rs))
        cols.append(Sd(k / rs))
    cols.append(Su(test[:, 4] / rs))
    cols.append(Sd(test[:, 5] / rs))
    return np.column_stack(cols)


def predict(train, test, beta, byhour=False):
    """Predicted probabilities for every test checkpoint: touches at each k (up, down) and new high / new low.
    byhour: each hour gets its own excursion distribution, pooled with the hours either side of it."""
    rt, rs = train[:, 6] ** beta, test[:, 6] ** beta
    if not byhour:
        return _cols(survival(train[:, 2] / rt), survival(train[:, 3] / rt), test, rs)
    out = np.zeros((len(test), 2 * len(KS) + 2))
    for g in range(LAST):
        ms = test[:, 1] == g
        if not ms.any():
            continue
        mt = np.abs(train[:, 1] - g) <= NEIGHBOURS
        out[ms] = _cols(survival(train[mt, 2] / rt[mt]), survival(train[mt, 3] / rt[mt]), test[ms], rs[ms])
    return out


def outcomes(test):
    cols = []
    for k in KS:
        cols.append(test[:, 2] >= k)
        cols.append(test[:, 3] >= k)
    cols.append(test[:, 2] >= test[:, 4] + 1e-12)
    cols.append(test[:, 3] >= test[:, 5] + 1e-12)
    return np.column_stack(cols).astype(float)


def slot_rates(train, test):
    """Plain per-hour rate of a later new high / new low: the benchmark for the extreme model."""
    out = np.zeros((len(test), 2))
    for i in range(LAST):
        a, b = train[:, 1] == i, test[:, 1] == i
        if a.any():
            out[b, 0] = (np.sum(train[a, 2] >= train[a, 4] + 1e-12) + 0.5) / (a.sum() + 1)
            out[b, 1] = (np.sum(train[a, 3] >= train[a, 5] + 1e-12) + 0.5) / (a.sum() + 1)
    return out


def choose_beta(train, byhour=False):
    """Pace exponent chosen on the training days only, by a split inside them."""
    days_ = np.unique(train[:, 0])
    cut = days_[int(len(days_) * 0.6)]
    a, b = train[train[:, 0] < cut], train[train[:, 0] >= cut]
    y = outcomes(b)
    best, bl = 0.0, None
    for be in BETAS:
        loss = float(np.mean((predict(a, b, be, byhour) - y) ** 2))
        if bl is None or loss < bl - 1e-9:
            best, bl = be, loss
    return best


def dm(day, la, lb):
    """Diebold-Mariano style t on per-day mean loss differences (a beats b when positive)."""
    u = np.unique(day)
    d = np.array([np.mean(lb[day == x] - la[day == x]) for x in u])
    if len(d) < 30 or d.std() == 0:
        return 0.0
    return float(d.mean() / (d.std(ddof=1) / math.sqrt(len(d))))


def skill(p, p0, y):
    b0 = np.sum((p0 - y) ** 2)
    return float(1 - np.sum((p - y) ** 2) / b0) if b0 else 0.0


def reliability(p, y, bins=10, min_n=40):
    out = []
    edges = np.linspace(0, 1, bins + 1)
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi if hi < 1 else p <= hi)
        if m.sum() >= min_n:
            out.append([round(float(p[m].mean()), 3), round(float(y[m].mean()), 3), int(m.sum())])
    return out


def z_needed(k, alpha=0.05):
    return NormalDist().inv_cdf(1 - alpha / (2 * max(1, k)))


def t_needed(k, alpha=0.05):
    return NormalDist().inv_cdf(1 - alpha / max(1, k))


# ---------- walk-forward ----------

def walk_forward(days, s):
    """Expanding-window refits every STEP days; returns stacked test rows with predictions."""
    P0, PH, P1, Y, B, T, betas = [], [], [], [], [], [], []
    start = max(WARM, SPAN + 30)
    for t0 in range(start, len(days), STEP):
        tr = list(range(SPAN, t0))
        te = list(range(t0, min(len(days), t0 + STEP)))
        w = profile(days, tr)
        train, test = checkpoints(days, s, w, tr), checkpoints(days, s, w, te)
        if not len(test):
            continue
        be = choose_beta(train, True)
        betas.append(be)
        P0.append(predict(train, test, 0.0))
        PH.append(predict(train, test, 0.0, True))
        P1.append(predict(train, test, be, True))
        Y.append(outcomes(test))
        B.append(slot_rates(train, test))
        T.append(test)
    if not T:
        return None
    return {"p0": np.vstack(P0), "ph": np.vstack(PH), "p1": np.vstack(P1), "y": np.vstack(Y), "base": np.vstack(B), "rows": np.vstack(T),
            "betas": betas}


def evaluate(wf, days):
    rows, y, pooled, p0, p1, base = wf["rows"], wf["y"], wf["p0"], wf["ph"], wf["p1"], wf["base"]
    day = rows[:, 0]
    n_days = len(np.unique(day))
    half = np.median(np.unique(day))
    first = day <= half
    res = {"days": n_days, "from": str(days[int(day.min())][0]), "to": str(days[int(day.max())][0]),
           "checkpoints": int(len(rows))}
    # does giving each hour its own distribution beat one shared distribution?
    la, lb = np.mean((p0 - y) ** 2, axis=1), np.mean((pooled - y) ** 2, axis=1)
    res["byHour"] = {"skill": round(float(1 - la.sum() / lb.sum()), 4), "t": round(dm(day, la, lb), 2),
                     "halves": [round(float(1 - la[first].sum() / lb[first].sum()), 4),
                                round(float(1 - la[~first].sum() / lb[~first].sum()), 4)],
                     "worstHourGap": worst_gap(rows, pooled, y), "worstHourGapByHour": worst_gap(rows, p0, y)}
    # touch calibration (hour-by-hour model, before pace)
    tc = slice(0, 2 * len(KS))
    pt, yt = p0[:, tc].ravel(), y[:, tc].ravel()
    res["touch"] = {
        "brier": round(float(np.mean((pt - yt) ** 2)), 4),
        "reliability": reliability(pt, yt),
        "byK": [{"k": k, "up": [round(float(p0[:, 2 * i].mean()), 3), round(float(y[:, 2 * i].mean()), 3)],
                 "dn": [round(float(p0[:, 2 * i + 1].mean()), 3), round(float(y[:, 2 * i + 1].mean()), 3)]}
                for i, k in enumerate(KS)],
    }
    # extreme model vs the plain per-hour rate
    ex = []
    for j, side in ((2 * len(KS), "high"), (2 * len(KS) + 1, "low")):
        l_model = (p0[:, j] - y[:, j]) ** 2
        l_base = (base[:, j - 2 * len(KS)] - y[:, j]) ** 2
        sk = skill(p0[:, j], base[:, j - 2 * len(KS)], y[:, j])
        h1 = skill(p0[first, j], base[first, j - 2 * len(KS)], y[first, j])
        h2 = skill(p0[~first, j], base[~first, j - 2 * len(KS)], y[~first, j])
        ex.append({"side": side, "skill": round(sk, 4), "t": round(dm(day, l_model, l_base), 2),
                   "halves": [round(h1, 4), round(h2, 4)], "reliability": reliability(p0[:, j], y[:, j])})
    res["extreme"] = ex
    # pace: does today's speed so far help?
    la = np.mean((p1 - y) ** 2, axis=1)
    lb = np.mean((p0 - y) ** 2, axis=1)
    sk = 1 - la.sum() / lb.sum()
    s1 = 1 - la[first].sum() / lb[first].sum()
    s2 = 1 - la[~first].sum() / lb[~first].sum()
    res["pace"] = {"skill": round(float(sk), 4), "t": round(dm(day, la, lb), 2), "halves": [round(float(s1), 4),
                   round(float(s2), 4)], "betas": sorted(set(wf["betas"]))}
    return res


def worst_gap(rows, p, y):
    """Largest gap, in points of probability, between predicted and actual touch rates at any hour (k = 1/2)."""
    j = 2 * KS.index(0.5)
    g = 0.0
    for i in range(LAST):
        m = rows[:, 1] == i
        if m.any():
            g = max(g, abs(p[m, j].mean() - y[m, j].mean()), abs(p[m, j + 1].mean() - y[m, j + 1].mean()))
    return round(float(g), 3)


def hour_tests(days, bar):
    out = []
    n = len(days)
    for j in range(SLOTS):
        r = np.array([math.log(C[j] / O[j]) for _, O, _, _, C in days])
        up = r > 0
        flat = r == 0
        k = int((~flat).sum())
        p = float(up.sum() / max(1, k))
        z = (p - 0.5) / math.sqrt(0.25 / max(1, k))
        t = float(r.mean() / (r.std(ddof=1) / math.sqrt(n))) if r.std() else 0.0
        h = n // 2
        p1 = float(up[:h].sum() / max(1, (~flat[:h]).sum()))
        p2 = float(up[h:].sum() / max(1, (~flat[h:]).sum()))
        same = (p1 - 0.5) * (p2 - 0.5) > 0
        out.append({"hour": SLOT_HOURS[j], "up": round(p, 3), "z": round(z, 2), "bp": round(float(r.mean() * 1e4), 2),
                    "t": round(t, 2), "halves": [round(p1, 3), round(p2, 3)],
                    "passed": bool(abs(z) >= bar and abs(t) >= bar and same and z * t > 0)})
    return out


def opening_range(rows5):
    """09:30-10:00 range from 5-minute bars, and what happened by 16:00."""
    days = {}
    for t, o, h, lo, c in rows5:
        if t.weekday() >= 5:
            continue
        mins = t.hour * 60 + t.minute
        if 570 <= mins < 960:
            days.setdefault(t.date(), []).append((mins, h, lo, c))
    stats = []
    for d in sorted(days):
        b = sorted(days[d])
        orb = [x for x in b if x[0] < 600]
        rest = [x for x in b if x[0] >= 600]
        if len(orb) < 6 or len(rest) < 60:
            continue
        hi, lo = max(x[1] for x in orb), min(x[2] for x in orb)
        up = any(x[1] > hi for x in rest)
        dn = any(x[2] < lo for x in rest)
        close = rest[-1][3]
        stats.append((up, dn, close > hi, close < lo, (hi - lo) / ((hi + lo) / 2)))
    n = len(stats)
    if not n:
        return {"days": 0, "status": "collecting", "need": MIN_OR_DAYS}
    a = np.array(stats, dtype=float)
    return {"days": n, "status": "tested" if n >= MIN_OR_DAYS else "collecting", "need": MIN_OR_DAYS,
            "breakHigh": round(float(a[:, 0].mean()), 3), "breakLow": round(float(a[:, 1].mean()), 3),
            "both": round(float((a[:, 0] * a[:, 1]).mean()), 3), "neither": round(float(((1 - a[:, 0]) * (1 - a[:, 1])).mean()), 3),
            "closeAbove": round(float(a[:, 2].mean()), 3), "closeBelow": round(float(a[:, 3].mean()), 3),
            "medianWidthBp": round(float(np.median(a[:, 4]) * 1e4), 1)}


# ---------- live state ----------

def today_state(days, s_last, R, rows1, rows5, now):
    """The current (or latest) trading day so far, for the page's live calculations."""
    key = day_key(now.astimezone(NY))
    recent = [r for r in (rows5 or rows1) if day_key(r[0]) == key]
    if not recent:
        last = (rows5 or rows1)[-1]
        key = day_key(last[0])
        recent = [r for r in (rows5 or rows1) if day_key(r[0]) == key]
    a = 2 / (SPAN + 1)
    # today's scale: the EWMA through the last complete day before `key`
    prior = [i for i, d in enumerate(days) if d[0] < key]
    s = None
    if prior:
        i = prior[-1]
        s0 = s_last[i]
        if s0 is not None:
            s = math.sqrt(a * R[i] ** 2 + (1 - a) * s0 * s0)
    t_last = recent[-1][0]
    return {"day": str(key), "open": float(recent[0][1]), "high": max(r[2] for r in recent), "low": min(r[3] for r in recent),
            "last": recent[-1][4], "lastTime": t_last.isoformat(timespec="minutes"),
            "barMinutes": 5 if rows5 and recent[-1] in rows5 else 60, "scale": round(s, 6) if s else None,
            "prevClose": float(days[prior[-1]][4][-1]) if prior else None}


HISTORY_START = {"nq": "2018-01-01", "gold": "2010-01-01"}  # first years with complete 23-hour days


def merge_history(futures, older):
    """Futures bars wherever they exist; the older source only for trading days before the first futures day."""
    if not older:
        return futures
    fut_rows = to_ny(futures)
    if not fut_rows:
        return older
    first = day_key(fut_rows[0][0])
    out = {t: v for t, v in older.items() if day_key(dt.datetime.fromisoformat(t).astimezone(NY)) < first}
    out.update(futures)
    return out


def run_market(m, source=None, fresh=True, now=None, log=print, history=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    older = history(m) if history else {}
    start = HISTORY_START.get(m)
    if start:
        older = {t: v for t, v in older.items() if t >= start}
    rows1 = to_ny(merge_history(load_bars(m, "1h", source, fresh, log), older))
    rows5 = to_ny(load_bars(m, "5m", source, fresh, log))
    days = hourly_days(rows1)
    if len(days) < WARM + 60:
        log(f"desk: {m} has only {len(days)} complete days")
        return None
    R, s = scales(days)
    wf = walk_forward(days, s)
    ev = evaluate(wf, days)
    idx = list(range(SPAN, len(days)))
    w = profile(days, idx)
    allrows = checkpoints(days, s, w, idx)
    beta_live = choose_beta(allrows, True)
    return {"days": days, "R": R, "s": s, "w": w, "rows": allrows, "beta_live": beta_live, "eval": ev,
            "rows1": rows1, "rows5": rows5, "now": now}


def finish(m, r, hour_bar, pace_bar, extreme_bar):
    ev, days, rows = r["eval"], r["days"], r["rows"]
    bh = ev["byHour"]
    bh["passed"] = bool(bh["t"] >= pace_bar and min(bh["halves"]) > 0)
    pace = ev["pace"]
    pace["passed"] = bool(pace["t"] >= pace_bar and min(pace["halves"]) > 0)
    for e in ev["extreme"]:
        e["passed"] = bool(e["t"] >= extreme_bar and min(e["halves"]) > 0)
    beta = r["beta_live"] if pace["passed"] else 0.0
    rt = rows[:, 6] ** beta

    def tables(mask):
        Su, Sd = survival(rows[mask, 2] / rt[mask]), survival(rows[mask, 3] / rt[mask])
        return [round(float(x), 4) for x in Su(GRID)], [round(float(x), 4) for x in Sd(GRID)]
    if bh["passed"]:
        t = [tables(np.abs(rows[:, 1] - g) <= NEIGHBOURS) for g in range(LAST)]
        surv_up, surv_dn = [a for a, _ in t], [b for _, b in t]
    else:
        surv_up, surv_dn = tables(np.ones(len(rows), bool))
    meta = MARKETS[m]
    return {
        "name": meta["name"], "full": meta["full"], "tick": meta["tick"], "pv": meta["pv"], "micro": meta["micro"],
        "dp": meta["dp"],
        "profile": [round(float(x), 5) for x in r["w"]], "hours": SLOT_HOURS, "last": LAST,
        "beta": beta, "grid": GRID.tolist(), "byHour": bh["passed"], "survUp": surv_up, "survDn": surv_dn,
        "tests": ev, "hourly": hour_tests(days[SPAN:], hour_bar),
        "opening": opening_range(r["rows5"]),
        "today": today_state(days, r["s"], r["R"], r["rows1"], r["rows5"], r["now"]),
        "history": {"days": len(days), "from": str(days[0][0]), "to": str(days[-1][0]),
                    "sources": "Dukascopy hourly (index CFD / spot) before mid-2024, Yahoo futures after"},
    }


def run(source=None, fresh=True, now=None, out=OUT, log=print, history=None):
    t0 = time.time()
    now = now or dt.datetime.now(dt.timezone.utc)
    raw = {}
    for m in MARKETS:
        try:
            r = run_market(m, source, fresh, now, log, history)
        except Exception as e:  # one market failing must not stop the other
            log(f"desk: {m} failed ({e!r})")
            r = None
        if r:
            raw[m] = r
    n = len(raw)
    hour_bar = z_needed(SLOTS * max(1, n))
    pace_bar = t_needed(max(1, n))
    extreme_bar = t_needed(2 * max(1, n))
    doc = {"updated": now.isoformat(timespec="minutes"), "source": "Yahoo Finance futures bars via the Displace archive",
           "bars": {"hour": round(hour_bar, 2), "pace": round(pace_bar, 2), "extreme": round(extreme_bar, 2)},
           "markets": {m: finish(m, r, hour_bar, pace_bar, extreme_bar) for m, r in raw.items()}}
    try:
        import lab
        daily = {m: d for m in MARKETS if (d := load_daily(m, source, log))}
        doc["lab"] = lab.run({m: (r["days"], r["s"], r["rows1"]) for m, r in raw.items()}, daily, now, log)
    except Exception as e:  # the desk must still publish if the lab fails
        log(f"desk: lab failed ({e!r})")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    for m, v in doc["markets"].items():
        t = v["tests"]
        log(f"desk: {m} {t['days']} test days; touch brier {t['touch']['brier']}; extreme skill "
            f"{t['extreme'][0]['skill']}/{t['extreme'][1]['skill']}; by hour {t['byHour']['skill']} (t {t['byHour']['t']}, worst gap "
            f"{t['byHour']['worstHourGap']} -> {t['byHour']['worstHourGapByHour']}); pace {t['pace']['skill']} (t {t['pace']['t']}, "
            f"{'used' if v['beta'] else 'not used'}); hours passed "
            f"{[h['hour'] for h in v['hourly'] if h['passed']]}; opening {v['opening']['days']} days")
    log(f"desk: {n} markets in {time.time() - t0:.1f}s")
    return doc


if __name__ == "__main__":
    import history as HIST
    src = sys.argv[1] if len(sys.argv) > 1 else None
    run(source=src, fresh=src is None, history=HIST.load)
