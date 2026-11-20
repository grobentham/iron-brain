"""Mutation search around the opening-range breakout, with a discovery / holdout split.

1. Discovery: every variant in GRID is run on the older data only (DISCOVERY_END), scored by its annual Sharpe.
2. Robustness: a variant's neighbours are the variants that differ from it in exactly one setting. Survivors need a
   broad plateau (good neighbours), enough trades, and profit in both halves of the discovery period.
3. Holdout: the top few per market are run once on the later data the search never saw, with a Bonferroni bar over
   everything taken to the holdout, and compared with the base opening-range breakout on the same days.

Run:  python engine/mutate.py            (writes site/data/mutations.json and prints a summary)
"""
import datetime as dt
import itertools
import json
import math
import os
import sys
from statistics import NormalDist

import numpy as np

import desk as D
import history as HIST
import lab as L

ND = NormalDist()
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "site", "research", "mutations.json")
DISCOVERY_END = {"nq": "2022-12-31", "gold": "2019-12-31"}
GRID = {
    "range": [1, 2],                     # opening range: 1 = 09:00-10:00, 2 = 09:00-11:00
    "lastEntry": [11, 13, 15],           # last hourly bar (start hour) in which a breakout may trigger
    # Stops at the range itself only. Tighter stops (a quarter or half of the remaining range) were tried first and
    # looked best, but 5-minute bars showed hourly bars overstate them by about 75%: such a stop is often hit inside
    # the entry hour, which hourly bars cannot resolve. They need minute data to be judged.
    "stop": ["mid", "far"],
    "target": [None, 1.0, 2.0],          # take profit at this multiple of the risk, or none
    "exit": [15, 16],                    # flat at 15:00 or at 16:00
    "filter": ["none", "pace", "gap", "trend", "narrow", "wide"],
    "side": ["both", "long"],
}
KEYS = list(GRID)
BASE = {"range": 1, "lastEntry": 15, "stop": "mid", "target": None, "exit": 16, "filter": "none", "side": "both"}
TOP = 5
MIN_TRADES = 150


def describe(v):
    rng = "09:00-10:00" if v["range"] == 1 else "09:00-11:00"
    stop = {"mid": "the middle of the range", "far": "the far side of the range",
            "rem50": "half the remaining range away", "rem25": "a quarter of the remaining range away"}[v["stop"]]
    filt = {"none": "", "pace": " Only on active days (range by the open at least its usual pace).",
            "gap": " Only in the direction of the move from the prior 16:00 close.",
            "trend": " Only in the direction of the 60-day trend.",
            "narrow": " Only when the opening range is narrower than usual.",
            "wide": " Only when the opening range is wider than usual."}[v["filter"]]
    side = "long only" if v["side"] == "long" else "either side"
    tgt = f", target {v['target']:g}R" if v["target"] else ""
    return (f"Opening range {rng}; breakout {side} accepted until {v['lastEntry'] + 1}:00; stop at {stop}{tgt}; "
            f"flat at {v['exit']}:00.{filt}")


def prepare(m, log=print):
    older = {t: x for t, x in HIST.load(m).items() if t >= D.HISTORY_START[m]}
    rows1 = D.to_ny(D.merge_history(D.load_bars(m, "1h", None, False, log), older))
    days = D.hourly_days(rows1)
    R, s = D.scales(days)
    w = L.profiles(days)
    daily = D.load_daily(m, None, log)
    dd = L.daily_closes(daily, dt.datetime.now(dt.timezone.utc))
    if m == "gold":
        keep = [i for i, d in enumerate(dd[0]) if d >= "2013-01-01"]
        dd = ([dd[0][i] for i in keep], dd[1][keep])
    ctx = L.intraday_context(days, s, w, L.daily_context(days, *dd))
    # opening-range width in day-range units, and its expanding median known before each day
    widths = {}
    for r in (1, 2):
        k0 = L.slot(9) + r
        z = [math.log(d[2][L.slot(9):k0].max() / d[3][L.slot(9):k0].min()) / s[i] if s[i] else None
             for i, d in enumerate(days)]
        med, hist_ = [], []
        for x in z:
            med.append(float(np.median(hist_)) if len(hist_) >= 60 else None)
            if x is not None:
                hist_.append(x)
        widths[r] = (z, med)
    return {"days": days, "s": s, "w": w, "ctx": ctx, "widths": widths}


def plan(v, i, P):
    d_, O, H, Lw, C = P["days"][i]
    s, w, c = P["s"][i], P["w"][i], P["ctx"][i] or {}
    if s is None or w is None:
        return None
    k0 = L.slot(9) + v["range"]
    hi, lo = H[L.slot(9):k0].max(), Lw[L.slot(9):k0].min()
    if not hi > lo:
        return None
    exit_slot = L.slot(v["exit"] - 1)
    last = min(L.slot(v["lastEntry"]), exit_slot - 1)
    allow = {1, -1} if v["side"] == "both" else {1}
    f = v["filter"]
    if f == "pace":
        dhi, dlo = H[:k0].max(), Lw[:k0].min()
        done = math.sqrt(max(1e-9, w[:k0].sum())) * s
        if math.log(dhi / dlo) / done < 1.0:
            return None
    elif f == "gap":
        if not c.get("prevClose"):
            return None
        allow &= {1 if C[k0 - 1] > c["prevClose"] else -1}
    elif f == "trend":
        if not c.get("mom60"):
            return None
        allow &= {c["mom60"]}
    elif f in ("narrow", "wide"):
        z, med = P["widths"][v["range"]]
        if z[i] is None or med[i] is None:
            return None
        if (f == "narrow") != (z[i] < med[i]):
            return None
    if not allow:
        return None
    for j in range(k0, last + 1):
        up, dn = L.first_side(O, H, Lw, j, hi, lo, allow)
        if up or dn:
            d = 1 if up else -1
            trig = hi if up else lo
            e = max(trig, O[j]) if d > 0 else min(trig, O[j])
            rem = math.sqrt(max(1e-9, w[j:exit_slot + 1].sum())) * s
            stop = {"mid": (hi + lo) / 2, "far": lo if d > 0 else hi,
                    "rem50": e * math.exp(-d * 0.5 * rem), "rem25": e * math.exp(-d * 0.25 * rem)}[v["stop"]]
            if (d > 0 and stop >= e) or (d < 0 and stop <= e):
                return None
            tgt = e + d * v["target"] * abs(e - stop) if v["target"] else None
            return j, d, stop, tgt, exit_slot, trig
    return None


def run_variant(v, P, m, idx):
    r = np.zeros(len(idx))
    n = 0
    for a, i in enumerate(idx):
        p = plan(v, i, P)
        if not p:
            continue
        e, x, why, held = L.simulate(P["days"][i], p)
        net = p[1] * (x - e) - L.COST[m]
        r[a] = net / e * 1e4
        n += 1
    return r, n


def stats(r, n):
    sd = r.std(ddof=1) if len(r) > 2 else 0
    sh = float(r.mean() / sd * math.sqrt(252)) if sd > 0 else 0.0
    t = float(r.mean() / (sd / math.sqrt(len(r)))) if sd > 0 else 0.0
    h = len(r) // 2
    return {"sharpe": round(sh, 3), "t": round(t, 2), "trades": n, "bpPerDay": round(float(r.mean()), 3),
            "halves": [round(float(r[:h].sum()), 1), round(float(r[h:].sum()), 1)]}


def key(v):
    return tuple(v[k] for k in KEYS)


def search(m, log=print):
    P = prepare(m, log)
    dates = [str(d[0]) for d in P["days"]]
    disc = [i for i, d in enumerate(dates) if d <= DISCOVERY_END[m]]
    hold = [i for i, d in enumerate(dates) if d > DISCOVERY_END[m]]
    variants = [dict(zip(KEYS, combo)) for combo in itertools.product(*GRID.values())]
    variants = [v for v in variants if not (v["lastEntry"] >= v["exit"])]
    res = {}
    for v in variants:
        r, n = run_variant(v, P, m, disc)
        res[key(v)] = {"v": v, "disc": stats(r, n)}
    # plateau: median Sharpe of the variants one setting away
    for kv, x in res.items():
        nb = []
        for a, k in enumerate(KEYS):
            for val in GRID[k]:
                if val == x["v"][k]:
                    continue
                kk = list(kv)
                kk[a] = val
                if tuple(kk) in res:
                    nb.append(res[tuple(kk)]["disc"]["sharpe"])
        x["plateau"] = round(float(np.median(nb)), 3) if nb else None
        d = x["disc"]
        x["eligible"] = d["trades"] >= MIN_TRADES and min(d["halves"]) > 0 and x["plateau"] is not None
        x["score"] = round(min(d["sharpe"], x["plateau"]), 3) if x["plateau"] is not None else None
    ranked = sorted([x for x in res.values() if x["eligible"]], key=lambda x: -x["score"])
    top = ranked[:TOP]
    base = res[key(BASE)]
    for x in top + [base]:
        r, n = run_variant(x["v"], P, m, hold)
        x["hold"] = stats(r, n)
        x["holdR"] = r
    best_disc = max(x["disc"]["sharpe"] for x in res.values())
    return {"m": m, "n": len(variants), "disc": (dates[disc[0]], dates[disc[-1]]),
            "hold": (dates[hold[0]], dates[hold[-1]]), "top": top, "base": base, "all": res,
            "bestDisc": best_disc}


def finalize(results, log=print):
    k = sum(len(r["top"]) for r in results)
    bar = ND.inv_cdf(1 - 0.05 / max(1, k))
    out = {"generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"), "grid": GRID,
           "base": BASE, "holdoutBar": round(bar, 2), "testedOnHoldout": k, "markets": {}}
    for R in results:
        base_r = R["base"]["holdR"]
        rows = []
        for x in R["top"]:
            diff = x["holdR"] - base_r
            sd = diff.std(ddof=1)
            t_vs = float(diff.mean() / (sd / math.sqrt(len(diff)))) if sd > 0 else 0.0
            ok = x["hold"]["t"] >= bar and min(x["hold"]["halves"]) > 0
            rows.append({"variant": x["v"], "rule": describe(x["v"]), "discovery": x["disc"], "plateau": x["plateau"],
                         "holdout": x["hold"], "tVsBase": round(t_vs, 2), "passed": bool(ok),
                         "better": bool(ok and t_vs >= 1.645)})
        sh = [x["disc"]["sharpe"] for x in R["all"].values()]
        out["markets"][R["m"]] = {
            "variants": R["n"], "discovery": R["disc"], "holdout": R["hold"],
            "base": {"rule": describe(BASE), "discovery": R["base"]["disc"], "holdout": R["base"]["hold"]},
            "discoverySharpe": {"best": round(max(sh), 2), "median": round(float(np.median(sh)), 2),
                                "share_positive": round(float(np.mean(np.array(sh) > 0)), 3)},
            "top": rows}
        log(f"mutate: {R['m']} {R['n']} variants; discovery {R['disc'][0]}..{R['disc'][1]}, holdout "
            f"{R['hold'][0]}..{R['hold'][1]}; base holdout Sharpe {R['base']['hold']['sharpe']} t {R['base']['hold']['t']}")
        for row in rows:
            log(f"   disc S {row['discovery']['sharpe']:5} plateau {row['plateau']:5} | hold S {row['holdout']['sharpe']:5} "
                f"t {row['holdout']['t']:5} vs base t {row['tVsBase']:5} {'PASS' if row['passed'] else '    '}"
                f"{' BETTER' if row['better'] else ''} | {row['rule']}")
    return out


def main():
    results = [search(m) for m in D.MARKETS]
    out = finalize(results)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(out, fh, indent=1)
    return out


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
