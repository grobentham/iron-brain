"""Refining the opening-range breakout for the prop account (written down 2026-11-21, before any of it was run).

Same method as refine_drive.py: every combination on NQ data to 2022, ranked by plateau (median Sharpe of the
variant and its one-setting neighbours), top five checked on 2023 onwards against a Bonferroni bar, and each
finalist's evaluation pass rate at 1 MNQ reported alone and next to opening drive v2. Fills use the lab's rules
(stop orders, path rule in the entry bar, a bar crossing both sides is a full loss); the breakeven stop moves only
at an hour's close after the entry bar.

Settings
  stop    middle or far side of the 09:00-10:00 range
  until   orders accepted until 12:00, 14:00 or 16:00
  exit    flat at 14:00, 15:00 or 16:00
  filter  none; skip drive days (no trade when the 09:00 hour qualifies as an opening drive, 0.25x the day range);
          narrow range (the 09:00-10:00 range under 0.3x the day range); not wide (under 0.6x)
  be      breakeven after an hour closes half the stop distance in profit: off / on

Run:  python engine/refine_orb.py   (writes site/research/orb-refine.json)
"""
import itertools
import json
import math
import os
import sys
from statistics import NormalDist

import numpy as np

import desk as D
import lab as L
import mutate as M
import refine_drive as RD

S = L.slot
K10 = S(10)
GRID = {"stop": ["mid", "far"], "until": [12, 14, 16], "exit": [14, 15, 16],
        "filter": ["none", "skip-drive", "narrow", "not-wide"], "be": [False, True]}
BASE = {"stop": "mid", "until": 16, "exit": 16, "filter": "none", "be": False}
DRIVE_V2 = dict(RD.BASE, filter="not-stretched", be=True, exit=15)
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site", "research", "orb-refine.json")


def key(p):
    return tuple(p[k] for k in GRID)


def trade(P, i, p):
    day, s = P["days"][i], P["s"][i]
    if s is None or P["w"][i] is None:
        return None
    _, O, H, Lw, C = day
    hi, lo = H[K10 - 1], Lw[K10 - 1]
    if not hi > lo:
        return None
    width = math.log(hi / lo)
    f = p["filter"]
    if f == "skip-drive" and abs(math.log(C[K10 - 1] / O[K10 - 1])) >= 0.25 * s:
        return None
    if f == "narrow" and width >= 0.3 * s:
        return None
    if f == "not-wide" and width >= 0.6 * s:
        return None
    mid = (hi + lo) / 2
    last = S(p["exit"] - 1)
    plan = None
    for j in range(K10, min(S(p["until"] - 1), last) + 1):
        up, dn = L.first_side(O, H, Lw, j, hi, lo)
        if up:
            plan = (j, 1, mid if p["stop"] == "mid" else lo, None, last, hi)
            break
        if dn:
            plan = (j, -1, mid if p["stop"] == "mid" else hi, None, last, lo)
            break
    if plan is None:
        return None
    k, d, stop = plan[0], plan[1], plan[2]
    e = max(plan[5], O[k]) if d > 0 else min(plan[5], O[k])
    dist = abs(e - stop)
    if not p["be"] or k == last:
        e2, x, _, _ = L.simulate(day, plan)
        return d * (x - e2), dist
    # entry bar exactly as the lab decides it
    e2, x, why, _ = L.simulate(day, (k, d, stop, None, k, plan[5]))
    if why == "stop":
        return d * (x - e2), dist
    if d * (C[k] - e) >= 0.5 * dist:
        stop = max(stop, e) if d > 0 else min(stop, e)
    for j in range(k + 1, last + 1):
        if (d > 0 and Lw[j] <= stop) or (d < 0 and H[j] >= stop):
            xx = min(stop, O[j]) if d > 0 else max(stop, O[j])
            return d * (xx - e), dist
        if d * (C[j] - e) >= 0.5 * dist:
            stop = max(stop, e) if d > 0 else min(stop, e)
    return d * (C[last] - e), dist


def series(P, m, idx, p, fn=trade):
    r, pts, n = np.zeros(len(idx)), np.zeros(len(idx)), 0
    for a, i in enumerate(idx):
        t = fn(P, i, p)
        if t is None:
            continue
        r[a] = (t[0] - L.COST[m]) / P["days"][i][1][K10] * 1e4
        pts[a] = t[0] - L.MICRO_COST[m]
        n += 1
    return r, pts, n


def main(log=print):
    m = "nq"
    P = M.prepare(m, log)
    dates = [str(d[0]) for d in P["days"]]
    disc = [i for i, d in enumerate(dates) if d <= M.DISCOVERY_END[m]]
    hold = [i for i, d in enumerate(dates) if d > M.DISCOVERY_END[m]]
    alli = list(range(len(dates)))
    pv = D.MARKETS[m]["micro"]
    variants = [dict(zip(GRID, v)) for v in itertools.product(*GRID.values())]
    st, sh = {}, {}
    for p in variants:
        r, _, n = series(P, m, disc, p)
        st[key(p)] = M.stats(r, n)
        sh[key(p)] = st[key(p)]["sharpe"] if n >= 80 else -9
    def neighbours(p):
        out = []
        for k, vals in GRID.items():
            if k == "filter":
                continue
            j = vals.index(p[k])
            for jj in (j - 1, j + 1):
                if 0 <= jj < len(vals):
                    q = dict(p); q[k] = vals[jj]; out.append(q)
        return out
    plateau = {key(p): float(np.median([sh[key(p)]] + [sh[key(q)] for q in neighbours(p)])) for p in variants}
    top = sorted(variants, key=lambda p: -plateau[key(p)])[:5]
    bar = NormalDist().inv_cdf(1 - 0.05 / len(top))
    _, dh, _ = series(P, m, hold, DRIVE_V2, RD.trade)
    _, da, _ = series(P, m, alli, DRIVE_V2, RD.trade)
    rows = []
    for p in [BASE] + top:
        rh, ph, nh = series(P, m, hold, p)
        _, pa, na_ = series(P, m, alli, p)
        h = M.stats(rh, nh)
        both = (ph != 0) | (dh != 0)
        rows.append({"settings": p, "base": p == BASE, "discovery": st[key(p)], "plateau": round(plateau[key(p)], 2),
                     "holdout": h, "passedHoldout": bool(h["t"] >= bar and min(h["halves"]) > 0),
                     "tradesPerYear": round(na_ / (len(alli) / 252), 1),
                     "corrDrive": round(float(np.corrcoef(ph[both], dh[both])[0, 1]), 2),
                     "prop": {"alone2023": RD.pass_rate(ph, pv), "withDrive2023": RD.pass_rate(ph + dh, pv),
                              "aloneAll": RD.pass_rate(pa, pv), "withDriveAll": RD.pass_rate(pa + da, pv)}})
    log(f"refine-orb: {len(variants)} variants; top 5 by plateau to the holdout (bar t >= {bar:.2f}); drive v2 alone "
        f"2023+: {RD.pass_rate(dh, pv)}")
    for x in rows:
        s_, d_, h_ = x["settings"], x["discovery"], x["holdout"]
        log(f"  {'BASE ' if x['base'] else '     '}{s_['stop']:3} until {s_['until']} exit {s_['exit']} {s_['filter']:10} "
            f"be {str(s_['be'])[0]} | disc S {d_['sharpe']:5.2f} plat {x['plateau']:5.2f} | hold S {h_['sharpe']:5.2f} "
            f"t {h_['t']:5.2f} n {h_['trades']:3} {h_['halves']} {'PASS' if x['passedHoldout'] else '    '} | "
            f"{x['tradesPerYear']}/yr corr {x['corrDrive']}\n        prop {x['prop']}")
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
