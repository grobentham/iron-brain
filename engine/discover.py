"""Discovery search over new strategy families from the trading literature, with a discovery / holdout split.

Every variant below was written down before any of them was run (registered 2026-11-20). Each family has at most a
few pre-set variants rather than a tuned grid.

1. Discovery: each variant runs on the older data only (NQ to 2022, gold to 2019, as in mutate.py).
2. A variant goes to the holdout if, on discovery, it has at least 100 trades, t >= 2.0 and profit in both halves.
3. Holdout: each one that advanced is run once on the later data, against a Bonferroni bar over everything that
   advanced. It must also profit in both halves of the holdout. Its correlation with breakout v2 says whether it adds
   anything new.

Every rule is flat at the 16:00 bar close (fitted to the MyFundedFutures account).

Run:  python engine/discover.py     (writes site/research/discovery.json and prints a summary)
"""
import datetime as dt
import json
import math
import os
import random
import sys
from statistics import NormalDist

import numpy as np

import desk as D
import lab as L
import mutate as M

ND = NormalDist()
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "site", "research", "discovery.json")
MIN_TRADES = 100
ADVANCE_T = 2.0
S = L.slot
EXIT16 = D.LAST


def _prev(P, i, n=1):
    """The n trading days before day i (oldest first), or None across a gap of more than a week."""
    if i < n:
        return None
    days = P["days"]
    if (days[i][0] - days[i - n][0]).days > 7 + 1.5 * n:
        return None
    return days[i - n:i]


def _rem(w, s, k, last=EXIT16):
    return math.sqrt(max(1e-9, w[k:last + 1].sum())) * s


def _breakout(day, hi, lo, first, last, stop_kind, exit_slot, allow=(1, -1)):
    """Stop orders above hi and below lo, accepted in bars first..last (a bar crossing both fills the first, by the path rule)."""
    _, O, H, Lw, C = day
    if not hi > lo:
        return None
    mid = (hi + lo) / 2
    for j in range(first, min(last, exit_slot) + 1):
        up, dn = L.first_side(O, H, Lw, j, hi, lo, allow)
        if up:
            return j, 1, lo if stop_kind == "far" else mid, None, exit_slot, hi
        if dn:
            return j, -1, hi if stop_kind == "far" else mid, None, exit_slot, lo
    return None


# ---------- families ----------

def london(stop_kind, exit_hour):
    """Asia-range breakout into London: the 18:00-03:00 range; stop orders beyond it accepted 03:00-09:00."""
    def f(i, P):
        day = P["days"][i]
        hi, lo = day[2][:S(3)].max(), day[3][:S(3)].min()
        return _breakout(day, hi, lo, S(3), S(8), stop_kind, S(exit_hour - 1))
    stop = "far side" if stop_kind == "far" else "middle"
    return f, (f"Asia-range breakout: the 18:00-03:00 range; a stop order above it buys and one below sells, accepted "
               f"03:00-09:00; stop at the {stop} of the range; flat at {exit_hour}:00.")


def premarket():
    """The 08:00-09:00 range, broken 09:00-12:00."""
    def f(i, P):
        day = P["days"][i]
        k = S(8)
        return _breakout(day, day[2][k], day[3][k], S(9), S(11), "far", EXIT16)
    return f, ("Pre-market range breakout: the 08:00-09:00 range; stop orders beyond it accepted 09:00-12:00; stop at "
               "the far side; flat at 16:00.")


def _session_range(day):
    return math.log(day[2][S(9):EXIT16 + 1].max() / day[3][S(9):EXIT16 + 1].min())


def nr_orb(n):
    """Crabel's narrow-range day: breakout v2 only after the narrowest day session of the last n."""
    def f(i, P):
        pv = _prev(P, i, n)
        if pv is None:
            return None
        r = [_session_range(d) for d in pv]
        if r[-1] > min(r):
            return None
        return L.q_orb_v2(P["days"][i], P["s"][i], P["w"][i])
    return f, (f"Narrow-range breakout (Crabel NR{n}): breakout v2 (09:00-10:00 range, orders until 12:00, far-side "
               f"stop, flat 16:00), only on days after the narrowest 09:00-16:00 session of the last {n}.")


def williams(k_mult):
    """Volatility breakout: today's 09:00 open plus or minus k times the prior day's full range."""
    def f(i, P):
        pv = _prev(P, i)
        if pv is None:
            return None
        y = pv[-1]
        rng = y[2].max() - y[3].min()
        day = P["days"][i]
        o9 = day[1][S(9)]
        hi, lo = o9 + k_mult * rng, o9 - k_mult * rng
        p = _breakout(day, hi, lo, S(9), S(14), "mid", EXIT16)
        if p:   # stop back at the 09:00 open
            p = (p[0], p[1], o9, None, p[4], p[5])
        return p
    return f, (f"Volatility breakout (Williams): stop orders at the 09:00 open plus and minus {k_mult:g}x the prior "
               f"day's full range, accepted 09:00-15:00; stop at the 09:00 open; flat at 16:00.")


def failed_breakout():
    """Fade an opening-range breakout that closes back inside the range."""
    def f(i, P):
        day = P["days"][i]
        _, O, H, Lw, C = day
        k0 = S(10)
        hi, lo = H[k0 - 1], Lw[k0 - 1]
        if not hi > lo:
            return None
        for j in range(k0, S(13) + 1):
            up, dn = H[j] > hi, Lw[j] < lo
            if up and dn:
                return None
            if up or dn:
                if up and C[j] < hi and O[j + 1] < H[j]:
                    return j + 1, -1, H[j], lo, EXIT16
                if dn and C[j] > lo and O[j + 1] > Lw[j]:
                    return j + 1, 1, Lw[j], hi, EXIT16
                return None
        return None
    return f, ("Failed breakout fade: when the first break of the 09:00-10:00 range (10:00-14:00) closes its hour back "
               "inside the range, trade the other way at the next open; stop at that hour's extreme, target the other "
               "side of the range, flat at 16:00.")


def prior_day_breakout():
    def f(i, P):
        pv = _prev(P, i)
        if pv is None:
            return None
        y = pv[-1]
        hi, lo = y[2].max(), y[3].min()
        day = P["days"][i]
        o9 = day[1][S(9)]
        if not lo < o9 < hi:
            return None
        p = _breakout(day, hi, lo, S(9), S(13), "mid", EXIT16)
        if p:
            p = (p[0], p[1], o9, None, p[4], p[5])
        return p
    return f, ("Prior-day range breakout: when 09:00 opens inside the prior day's full range, stop orders at that "
               "day's high and low, accepted 09:00-14:00; stop at the 09:00 open; flat at 16:00.")


def vol_regime(high):
    """Breakout v2 only when the last five days' ranges are above (or below) the long-run scale."""
    def f(i, P):
        pv = _prev(P, i, 5)
        s = P["s"][i]
        if pv is None or s is None:
            return None
        recent = float(np.mean([math.log(d[2].max() / d[3].min()) for d in pv]))
        if (recent > s) != high:
            return None
        return L.q_orb_v2(P["days"][i], s, P["w"][i])
    word = "rising" if high else "falling"
    return f, (f"Breakout v2 in {word} volatility: only when the average range of the last five days is "
               f"{'above' if high else 'below'} the 20-day EWMA scale.")


def afternoon():
    def f(i, P):
        day = P["days"][i]
        k = S(12)
        return _breakout(day, day[2][k], day[3][k], S(13), S(14), "far", EXIT16)
    return f, ("Afternoon range breakout: the 12:00-13:00 range; stop orders beyond it accepted 13:00-15:00; stop at "
               "the far side; flat at 16:00.")


def gao(signal_end, entry):
    """Intraday momentum: the return from the prior 16:00 close to signal_end sets the direction from `entry`."""
    def f(i, P):
        c = P["ctx"][i] or {}
        if not c.get("prevClose"):
            return None
        day = P["days"][i]
        m = math.log(day[4][S(signal_end) - 1] / c["prevClose"])
        if m == 0:
            return None
        d = 1 if m > 0 else -1
        k = S(entry)
        return k, d, day[1][k] * math.exp(-d * 0.5 * _rem(P["w"][i], P["s"][i], k)), None, EXIT16
    return f, (f"Intraday momentum, later signal: the return from the prior 16:00 close to {signal_end}:00 sets the "
               f"direction; trade at the {entry}:00 open, stop half the remaining range away, flat at 16:00.")


def first_hour_last(min_frac):
    def f(i, P):
        day = P["days"][i]
        k9 = S(9)
        m = math.log(day[4][k9] / day[1][k9])
        if abs(m) < min_frac * P["s"][i]:
            return None
        d = 1 if m > 0 else -1
        k = S(14)
        return k, d, day[1][k] * math.exp(-d * 0.5 * _rem(P["w"][i], P["s"][i], k)), None, EXIT16
    return f, (f"First hour to last two hours: a 09:00-10:00 move of at least {min_frac:g}x the typical day range sets "
               f"the direction for 14:00-16:00; stop half the remaining range away.")


def tsmom_vote(unanimous):
    """Time-series momentum over 5, 20 and 60 days, voted, traded in the day session."""
    def f(i, P):
        pv = _prev(P, i, 61)
        if pv is None:
            return None
        c = [d[4][EXIT16] for d in pv]
        votes = [np.sign(math.log(c[-1] / c[-1 - n])) for n in (5, 20, 60)]
        tot = sum(votes)
        if unanimous and abs(tot) < 3:
            return None
        if tot == 0:
            return None
        d = 1 if tot > 0 else -1
        k = S(10)
        day = P["days"][i]
        return k, d, day[1][k] * math.exp(-d * 0.5 * _rem(P["w"][i], P["s"][i], k)), None, EXIT16
    return f, (f"Trend vote: the signs of the 5-, 20- and 60-day returns ({'all three agree' if unanimous else 'majority'}) "
               f"set the direction at the 10:00 open; stop half the remaining range away, flat at 16:00.")


def gap_reversal(min_frac):
    """Fade a large overnight move once the session's first hour fails to extend it."""
    def f(i, P):
        c = P["ctx"][i] or {}
        if not c.get("prevClose"):
            return None
        day = P["days"][i]
        _, O, H, Lw, C = day
        k9 = S(9)
        g = math.log(O[k9] / c["prevClose"])
        if abs(g) < min_frac * P["s"][i]:
            return None
        if (g > 0 and C[k9] >= O[k9]) or (g < 0 and C[k9] <= O[k9]):
            return None
        d = -1 if g > 0 else 1
        k = S(10)
        stop = H[k9] if d < 0 else Lw[k9]
        if (d < 0 and stop <= O[k]) or (d > 0 and stop >= O[k]):
            return None
        return k, d, stop, c["prevClose"], EXIT16
    return f, (f"Gap reversal: when 09:00 opens at least {min_frac:g}x the typical range away from the prior 16:00 "
               f"close and the 09:00 hour moves back against it, fade the gap at 10:00; stop beyond the 09:00 hour, "
               f"target the prior close, flat at 16:00.")


FAMILIES = {
    "london-far-12": london("far", 12), "london-far-16": london("far", 16),
    "london-mid-12": london("mid", 12), "london-mid-16": london("mid", 16),
    "premarket": premarket(),
    "nr4-orb": nr_orb(4), "nr7-orb": nr_orb(7),
    "williams-0.5": williams(0.5), "williams-0.3": williams(0.3),
    "failed-breakout": failed_breakout(),
    "prior-day-breakout": prior_day_breakout(),
    "orb-vol-rising": vol_regime(True), "orb-vol-falling": vol_regime(False),
    "afternoon": afternoon(),
    "gao-noon": gao(12, 14), "gao-13": gao(13, 15),
    "first-hour-last": first_hour_last(0.25),
    "trend-vote": tsmom_vote(False), "trend-vote-all": tsmom_vote(True),
    "gap-reversal": gap_reversal(0.3),
}


def run(fn, P, m, idx):
    r = np.zeros(len(idx))
    trades = []
    for a, i in enumerate(idx):
        if P["s"][i] is None or P["w"][i] is None:
            continue
        p = fn(i, P)
        if not p or not (0 <= p[0] <= p[4] < D.SLOTS):
            continue
        e, x, why, held = L.simulate(P["days"][i], p)
        if abs(e - p[2]) <= 0:
            continue
        net = p[1] * (x - e) - L.COST[m]
        r[a] = net / e * 1e4
        trades.append({"i": i, "plan": p, "bp": r[a]})
    return r, trades


def random_beat(trades, r, P, m, idx, rnd, n=200):
    pos = {i: a for a, i in enumerate(idx)}
    real = float(r.sum())
    sub = [i for i in idx if P["s"][i] is not None and P["w"][i] is not None]
    wins = 0
    for _ in range(n):
        tot = 0.0
        for t in trades:
            k, d, stop, target, last = t["plan"][:5]
            span = last - k
            i = rnd.choice(sub)
            k2 = rnd.randrange(0, D.LAST + 1 - span)
            day = P["days"][i]
            f = day[1][k2] / P["days"][t["i"]][1][k]
            plan = (k2, d, stop * f, target * f if target is not None else None, k2 + span)
            e, x, _, _ = L.simulate(day, plan)
            tot += (d * (x - e) - L.COST[m]) / e * 1e4
        wins += real > tot
    return wins / n


def main(log=print):
    rnd = random.Random(11)
    res = {}
    base = {}
    for m in D.MARKETS:
        P = M.prepare(m, log)
        dates = [str(d[0]) for d in P["days"]]
        disc = [i for i, d in enumerate(dates) if d <= M.DISCOVERY_END[m]]
        hold = [i for i, d in enumerate(dates) if d > M.DISCOVERY_END[m]]
        v2 = lambda i, P: L.q_orb_v2(P["days"][i], P["s"][i], P["w"][i])
        base[m] = {"P": P, "disc": disc, "hold": hold, "v2hold": run(v2, P, m, hold)[0],
                   "range": {"discovery": [dates[disc[0]], dates[disc[-1]]], "holdout": [dates[hold[0]], dates[hold[-1]]]}}
        for fid, (fn, rule) in FAMILIES.items():
            r, tr = run(fn, P, m, disc)
            st = M.stats(r, len(tr))
            adv = st["trades"] >= MIN_TRADES and st["t"] >= ADVANCE_T and min(st["halves"]) > 0
            res[(m, fid)] = {"market": m, "id": fid, "rule": rule, "discovery": st, "advanced": adv}
    advanced = [k for k, x in res.items() if x["advanced"]]
    bar = ND.inv_cdf(1 - 0.05 / max(1, len(advanced)))
    for k in advanced:
        m, fid = k
        B = base[m]
        r, tr = run(FAMILIES[fid][0], B["P"], m, B["hold"])
        st = M.stats(r, len(tr))
        both = (r != 0) | (B["v2hold"] != 0)
        corr = float(np.corrcoef(r[both], B["v2hold"][both])[0, 1]) if both.sum() > 10 else None
        beat = random_beat(tr, r, B["P"], m, B["hold"], rnd)
        res[k].update({"holdout": st, "corrV2": round(corr, 2) if corr is not None else None,
                       "beatRandom": round(beat, 3),
                       "passed": bool(st["t"] >= bar and min(st["halves"]) > 0 and beat >= 0.95)})
    out = {"generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"), "families": len(FAMILIES),
           "tests": len(res), "advanceRule": f"discovery t >= {ADVANCE_T}, >= {MIN_TRADES} trades, both halves positive",
           "advanced": len(advanced), "holdoutBar": round(bar, 2),
           "periods": {m: base[m]["range"] for m in base}, "results": list(res.values())}
    log(f"discover: {len(res)} tests; {len(advanced)} advanced; holdout bar t >= {bar:.2f}")
    for x in sorted(res.values(), key=lambda x: (x["market"], -x["discovery"]["sharpe"])):
        h = x.get("holdout")
        log(f"  {x['market']:4} {x['id']:20} disc S {x['discovery']['sharpe']:6.2f} t {x['discovery']['t']:5.2f} "
            f"n {x['discovery']['trades']:5} " +
            (f"| hold S {h['sharpe']:6.2f} t {h['t']:5.2f} n {h['trades']:4} halves {h['halves']} corrV2 {x['corrV2']} "
             f"rand {x['beatRandom']} {'PASS' if x['passed'] else ''}" if h else ""))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(out, fh, indent=1)
    return out


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
