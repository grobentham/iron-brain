"""Discovery round two (written down 2026-11-21, before any of it was run): intraday rules for the prop account that
trade other setups than the current plan (opening drive + prior-day range breakout). Same method as discover.py:
discovery on NQ to 2022 and gold to 2019; a rule advances with >= 100 trades, t >= 2.0 and both halves positive; the
holdout bar is Bonferroni over everything that advanced, and the rule must also beat random timing. Every rule is
flat at 16:00. Also reported: correlation with the current plan on the holdout and whether adding the rule at
1 MNQ raises the plan's evaluation pass rate.

Result (2026-11-21): only the overnight range breakout passed (NQ holdout Sharpe 1.95, gold 1.37). It was NOT
registered: on random walks the lab passes it too. Its stop sits at the 09:00 open, and when the order fills in the
09:00 hour the hourly path rule cannot tell whether price came back to the stop inside that hour. On 5-minute bars
since September it kept about 72% of the hourly profit on NQ (the prior-day breakout about 51%). Judging these
breakouts needs minute data over the whole history.

Run:  python engine/discover2.py   (writes site/research/discovery2.json)
"""
import datetime as dt
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
import discover as X

S = L.slot
EXIT16 = D.LAST
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "site", "research", "discovery2.json")


def _rem(w, s, k):
    return math.sqrt(max(1e-9, w[k:EXIT16 + 1].sum())) * s


def _go(day, s, w, k, d):
    return k, d, day[1][k] * math.exp(-d * 0.5 * _rem(w, s, k)), None, EXIT16


def _hour_move(day, h):
    k = S(h)
    return math.log(day[4][k] / day[1][k])


def _drive9(day, s):
    return abs(_hour_move(day, 9)) >= 0.25 * s


def hour_drive(h, th, skip_drive9=False):
    """A strong move in hour h sets the direction from the next hour's open."""
    def f(i, P):
        day, s, w = P["days"][i], P["s"][i], P["w"][i]
        if skip_drive9 and _drive9(day, s):
            return None
        m = _hour_move(day, h)
        if abs(m) < th * s:
            return None
        return _go(day, s, w, S(h + 1) if h + 1 < 24 else 0, 1 if m > 0 else -1)
    extra = " on days the 09:00 hour did not already qualify as an opening drive" if skip_drive9 else ""
    return f, (f"Hour drive {h:02d}:00: when the {h:02d}:00-{h + 1:02d}:00 hour moves at least {th:g}x the typical "
               f"day range, trade its direction from {h + 1:02d}:00{extra}; stop half the remaining range away; flat "
               f"16:00.")


def two_hour_drive():
    def f(i, P):
        day, s, w = P["days"][i], P["s"][i], P["w"][i]
        if _drive9(day, s):
            return None
        m = math.log(day[4][S(10)] / day[1][S(9)])
        if abs(m) < 0.35 * s:
            return None
        return _go(day, s, w, S(11), 1 if m > 0 else -1)
    return f, ("Two-hour drive: on days without a 09:00 opening drive, a 09:00-11:00 move of at least 0.35x the "
               "typical day range sets the direction from 11:00; stop half the remaining range away; flat 16:00.")


def overnight_range_breakout():
    def f(i, P):
        day = P["days"][i]
        _, O, H, Lw, C = day
        hi, lo, o9 = H[:S(9)].max(), Lw[:S(9)].min(), O[S(9)]
        if not lo < o9 < hi:
            return None
        for j in range(S(9), S(13) + 1):
            up, dn = L.first_side(O, H, Lw, j, hi, lo)
            if up:
                return j, 1, o9, None, EXIT16, hi
            if dn:
                return j, -1, o9, None, EXIT16, lo
        return None
    return f, ("Overnight range breakout: stop orders at the 18:00-09:00 high and low, accepted 09:00-14:00 "
               "(whichever trades first); stop at the 09:00 open; flat 16:00.")


def overnight_continuation(th):
    def f(i, P):
        c = P["ctx"][i] or {}
        if not c.get("prevClose"):
            return None
        day, s, w = P["days"][i], P["s"][i], P["w"][i]
        m = math.log(day[1][S(9)] / c["prevClose"])
        if abs(m) < th * s:
            return None
        return _go(day, s, w, S(9), 1 if m > 0 else -1)
    return f, (f"Overnight continuation: when 09:00 opens at least {th:g}x the typical day range away from the prior "
               f"16:00 close, trade in that direction at 09:00; stop half the remaining range away; flat 16:00.")


def close_location(momentum):
    def f(i, P):
        pv = X._prev(P, i)
        if pv is None:
            return None
        y = pv[-1]
        hi, lo, cl = y[2].max(), y[3].min(), y[4][EXIT16]
        if not hi > lo:
            return None
        loc = (cl - lo) / (hi - lo)
        if 0.2 < loc < 0.8:
            return None
        d = 1 if loc >= 0.8 else -1
        if not momentum:
            d = -d
        day, s, w = P["days"][i], P["s"][i], P["w"][i]
        return _go(day, s, w, S(9), d)
    kind = "in the same direction" if momentum else "against it"
    return f, (f"Prior-day close location ({'momentum' if momentum else 'reversal'}): when the prior day's 16:00 "
               f"close was in the top or bottom fifth of its full range, trade {kind} at 09:00; stop half the "
               f"remaining range away; flat 16:00.")


def inside_hour():
    """Crabel's inside bar: the 10:00 hour stays inside the 09:00 range; break the range from 11:00."""
    def f(i, P):
        day = P["days"][i]
        _, O, H, Lw, C = day
        k9, k10 = S(9), S(10)
        hi, lo = H[k9], Lw[k9]
        if not (H[k10] <= hi and Lw[k10] >= lo and hi > lo):
            return None
        for j in range(S(11), S(13) + 1):
            up, dn = L.first_side(O, H, Lw, j, hi, lo)
            if up:
                return j, 1, lo, None, EXIT16, hi
            if dn:
                return j, -1, hi, None, EXIT16, lo
        return None
    return f, ("Inside-hour breakout: when the 10:00-11:00 hour stays inside the 09:00-10:00 range, stop orders "
               "beyond that range from 11:00 to 14:00; stop at the far side; flat 16:00.")


FAMILIES = {
    "drive-10": hour_drive(10, 0.2, skip_drive9=True),
    "two-hour-drive": two_hour_drive(),
    "drive-08": hour_drive(8, 0.2),
    "drive-03": hour_drive(3, 0.15),
    "drive-13": hour_drive(13, 0.15),
    "overnight-range-breakout": overnight_range_breakout(),
    "overnight-cont-0.25": overnight_continuation(0.25),
    "overnight-cont-0.5": overnight_continuation(0.5),
    "close-loc-momentum": close_location(True),
    "close-loc-reversal": close_location(False),
    "inside-hour": inside_hour(),
}


def plan_stream(P, m, idx):
    """The current plan, opening drive + prior-day range breakout, 1 MNQ each: per-day points."""
    drive = lambda i, P: L.i_opening_drive(P["days"][i], P["s"][i], P["w"][i])
    pdb = lambda i, P: L.q_prior_day_breakout(P["days"][i], P["s"][i], P["w"][i], P["ctx"][i])
    return sum(_points(f, P, m, idx) for f in (drive, pdb))


def _points(fn, P, m, idx):
    out = np.zeros(len(idx))
    for a, i in enumerate(idx):
        if P["s"][i] is None or P["w"][i] is None:
            continue
        p = fn(i, P)
        if not p or not (0 <= p[0] <= p[4] < D.SLOTS):
            continue
        e, x, _, _ = L.simulate(P["days"][i], p)
        out[a] = p[1] * (x - e) - L.MICRO_COST[m]
    return out


def pass_rate(usd):
    u = np.maximum(usd, -A.ACCOUNT["dll"])
    r = A._simulate(u, len(u), random.Random(11), 3000, 250, 50000, 3000, 50100, 2000)
    return r["pass"], r["breach"], r["medianDays"]


def main(log=print):
    rnd = random.Random(21)
    res, base = {}, {}
    for m in D.MARKETS:
        P = M.prepare(m, log)
        dates = [str(d[0]) for d in P["days"]]
        disc = [i for i, d in enumerate(dates) if d <= M.DISCOVERY_END[m]]
        hold = [i for i, d in enumerate(dates) if d > M.DISCOVERY_END[m]]
        base[m] = {"P": P, "disc": disc, "hold": hold}
        for fid, (fn, rule) in FAMILIES.items():
            r, tr = X.run(fn, P, m, disc)
            st = M.stats(r, len(tr))
            adv = st["trades"] >= X.MIN_TRADES and st["t"] >= X.ADVANCE_T and min(st["halves"]) > 0
            res[(m, fid)] = {"market": m, "id": fid, "rule": rule, "discovery": st, "advanced": adv}
    advanced = [k for k, x in res.items() if x["advanced"]]
    bar = NormalDist().inv_cdf(1 - 0.05 / max(1, len(advanced)))
    # the plan on all NQ days, for the pass-rate comparison
    Pn = base["nq"]["P"]
    alln = list(range(len(Pn["days"])))
    plan_all = plan_stream(Pn, "nq", alln) * D.MARKETS["nq"]["micro"]
    p0 = pass_rate(plan_all)
    for k in advanced:
        m, fid = k
        B = base[m]
        fn = FAMILIES[fid][0]
        r, tr = X.run(fn, B["P"], m, B["hold"])
        st = M.stats(r, len(tr))
        beat = X.random_beat(tr, r, B["P"], m, B["hold"], rnd)
        info = {"holdout": st, "beatRandom": round(beat, 3),
                "passed": bool(st["t"] >= bar and min(st["halves"]) > 0 and beat >= 0.95)}
        if m == "nq":
            planh = plan_stream(B["P"], m, B["hold"])
            both = (r != 0) | (planh != 0)
            info["corrPlan"] = round(float(np.corrcoef(r[both], planh[both])[0, 1]), 2)
            add = _points(fn, Pn, "nq", alln) * D.MARKETS["nq"]["micro"]
            info["planPass"] = {"before": p0, "after": pass_rate(plan_all + add)}
        res[k].update(info)
    out = {"generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"), "tests": len(res),
           "advanced": len(advanced), "holdoutBar": round(bar, 2), "results": list(res.values())}
    log(f"discover2: {len(res)} tests; {len(advanced)} advanced; holdout bar t >= {bar:.2f}; plan pass/breach/days {p0}")
    for x in sorted(res.values(), key=lambda x: (x["market"], -x["discovery"]["sharpe"])):
        h = x.get("holdout")
        log(f"  {x['market']:4} {x['id']:26} disc S {x['discovery']['sharpe']:6.2f} t {x['discovery']['t']:5.2f} "
            f"n {x['discovery']['trades']:5} " +
            (f"| hold S {h['sharpe']:5.2f} t {h['t']:5.2f} n {h['trades']:4} halves {h['halves']} rand "
             f"{x['beatRandom']} corr {x.get('corrPlan')} plan {x.get('planPass')} {'PASS' if x['passed'] else ''}"
             if h else ""))
    with open(OUT, "w") as fh:
        json.dump(out, fh, indent=1)
    return out


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
