"""Refining the opening drive (written down 2026-11-21, before any of it was run).

Every combination of the settings below is run on NQ data to 2022 (discovery). Variants are ranked by their plateau:
the median Sharpe of the variant and its one-setting neighbours, so a lucky spike surrounded by poor settings does
not win. The top five by plateau go to the holdout (2023 on), with a Bonferroni bar over five, and are compared
there with the base rule. For the prop account, each finalist's evaluation pass rate at 1 MNQ with no time limit is
also reported. The entry is always at a bar open and the stop is only ever moved at a bar close, so hourly bars
decide every fill without guessing the order of prices inside a bar.

Settings
  th      minimum 09:00-10:00 move, x typical day range: 0.15, 0.20, 0.25, 0.30
  stop    stop distance, x the remaining range from 10:00: 0.35, 0.50, 0.75
  exit    flat at 14:00, 15:00 or 16:00
  filter  none; strong close (the hour closes in the outer 30% of its own range, in the move's direction);
          overnight agrees (09:00 opens on the same side of the prior 16:00 close as the move); trend agrees
          (the move is in the direction of the 20-day trend); not stretched (the move is under 0.6x the day range)
  be      breakeven: off, or once an hour closes 0.5x the stop distance in profit, the stop moves to the entry
          from the next hour

Run:  python engine/refine_drive.py   (writes site/research/drive-refine.json)
"""
import itertools
import json
import math
import os
import random
import sys
from statistics import NormalDist

import numpy as np

import account as A
import desk as D
import lab as L
import mutate as M

S = L.slot
K10 = S(10)
GRID = {"th": [0.15, 0.20, 0.25, 0.30], "stop": [0.35, 0.50, 0.75], "exit": [14, 15, 16],
        "filter": ["none", "strong-close", "overnight-agrees", "trend-agrees", "not-stretched"], "be": [False, True]}
BASE = {"th": 0.25, "stop": 0.50, "exit": 16, "filter": "none", "be": False}
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site", "research", "drive-refine.json")


def key(p):
    return tuple(p[k] for k in GRID)


def trade(P, i, p):
    """Net points for one contract (before costs) or None."""
    day, s, w = P["days"][i], P["s"][i], P["w"][i]
    if s is None or w is None:
        return None
    _, O, H, Lw, C = day
    m = math.log(C[K10 - 1] / O[K10 - 1])
    if abs(m) < p["th"] * s:
        return None
    d = 1 if m > 0 else -1
    f = p["filter"]
    if f == "strong-close":
        hi, lo = H[K10 - 1], Lw[K10 - 1]
        if not hi > lo:
            return None
        loc = (C[K10 - 1] - lo) / (hi - lo)
        if (d > 0 and loc < 0.7) or (d < 0 and loc > 0.3):
            return None
    elif f == "overnight-agrees":
        pc = (P["ctx"][i] or {}).get("prevClose")
        if not pc or np.sign(O[K10 - 1] - pc) != d:
            return None
    elif f == "trend-agrees":
        if i < 21 or (day[0] - P["days"][i - 21][0]).days > 40:
            return None
        if np.sign(P["days"][i - 1][4][D.LAST] - P["days"][i - 21][4][D.LAST]) != d:
            return None
    elif f == "not-stretched":
        if abs(m) >= 0.6 * s:
            return None
    last = S(p["exit"] - 1)
    rem = math.sqrt(max(1e-9, w[K10:D.LAST + 1].sum())) * s
    e = O[K10]
    dist = e * (1 - math.exp(-p["stop"] * rem))
    stop = e - d * dist
    for j in range(K10, last + 1):
        if (d > 0 and Lw[j] <= stop) or (d < 0 and H[j] >= stop):
            x = min(stop, O[j]) if d > 0 else max(stop, O[j])
            if j == K10:
                x = stop
            return d * (x - e), dist
        if p["be"] and d * (C[j] - e) >= 0.5 * dist:
            stop = max(stop, e) if d > 0 else min(stop, e)
    return d * (C[last] - e), dist


def series(P, m, idx, p):
    r = np.zeros(len(idx))
    pts = np.zeros(len(idx))
    n = 0
    for a, i in enumerate(idx):
        t = trade(P, i, p)
        if t is None:
            continue
        net = t[0] - L.COST[m]
        r[a] = net / P["days"][i][1][K10] * 1e4
        pts[a] = t[0] - L.MICRO_COST[m]
        n += 1
    return r, pts, n


def pass_rate(pts, pv):
    u = np.maximum(pts * pv, -A.ACCOUNT["dll"])
    out = A._simulate(u, len(u), random.Random(11), 3000, 900, 50000, 3000, 50100, 2000)
    return {"pass": out["pass"], "fail": out["breach"], "medianDays": out["medianDays"]}


def main(log=print):
    m = "nq"
    P = M.prepare(m, log)
    dates = [str(d[0]) for d in P["days"]]
    disc = [i for i, d in enumerate(dates) if d <= M.DISCOVERY_END[m]]
    hold = [i for i, d in enumerate(dates) if d > M.DISCOVERY_END[m]]
    alli = list(range(len(dates)))
    names = list(GRID)
    variants = [dict(zip(names, v)) for v in itertools.product(*GRID.values())]
    sh = {}
    stats = {}
    for p in variants:
        r, _, n = series(P, m, disc, p)
        st = M.stats(r, n)
        stats[key(p)] = st
        sh[key(p)] = st["sharpe"] if n >= 80 else -9
    def neighbours(p):
        out = []
        for k, vals in GRID.items():
            j = vals.index(p[k])
            for jj in (j - 1, j + 1):
                if 0 <= jj < len(vals) and not (k == "filter"):
                    q = dict(p); q[k] = vals[jj]; out.append(q)
        return out
    plateau = {key(p): float(np.median([sh[key(p)]] + [sh[key(q)] for q in neighbours(p)])) for p in variants}
    ranked = sorted(variants, key=lambda p: -plateau[key(p)])
    top = ranked[:5]
    bar = NormalDist().inv_cdf(1 - 0.05 / len(top))
    pv = D.MARKETS[m]["micro"]
    rows = []
    for p in [BASE] + top:
        rh, _, nh = series(P, m, hold, p)
        sth = M.stats(rh, nh)
        _, pts, nall = series(P, m, alli, p)
        rows.append({"settings": p, "discovery": stats[key(p)], "plateau": round(plateau[key(p)], 2), "holdout": sth,
                     "passedHoldout": bool(sth["t"] >= bar and min(sth["halves"]) > 0), "tradesPerYear":
                     round(nall / (len(alli) / 252), 1), "prop1MNQ": pass_rate(pts, pv), "base": p == BASE})
    log(f"refine-drive: {len(variants)} variants on discovery; top 5 by plateau to the holdout (bar t >= {bar:.2f})")
    for x in rows:
        s_, d_, h_ = x["settings"], x["discovery"], x["holdout"]
        log(f"  {'BASE ' if x['base'] else '     '}th {s_['th']:.2f} stop {s_['stop']:.2f} exit {s_['exit']} "
            f"{s_['filter']:16} be {str(s_['be'])[0]} | disc S {d_['sharpe']:5.2f} plat {x['plateau']:5.2f} | hold S "
            f"{h_['sharpe']:5.2f} t {h_['t']:5.2f} n {h_['trades']:3} halves {h_['halves']} "
            f"{'PASS' if x['passedHoldout'] else '    '} | {x['tradesPerYear']}/yr prop {x['prop1MNQ']}")
    # what each single setting does on the holdout, one change at a time from the base (for the write-up)
    log("  one change from the base, holdout Sharpe:")
    for k, vals in GRID.items():
        out = []
        for v in vals:
            q = dict(BASE); q[k] = v
            rh, _, nh = series(P, m, hold, q)
            out.append(f"{v}: {M.stats(rh, nh)['sharpe']:.2f}")
        log(f"    {k:7} " + "  ".join(out))
    with open(OUT, "w") as fh:
        json.dump({"variants": len(variants), "holdoutBar": round(bar, 2), "finalists": rows}, fh, indent=1)
    return rows


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
