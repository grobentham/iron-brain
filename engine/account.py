"""The prop account Iron Brain is fitted to: MyFundedFutures 50K Builder.

Rules from MyFundedFutures' help center ("Builder Plan 50k - A Comprehensive Guide" and "Permitted times to trade"),
checked 2026-11-20. Prop firms change rules often: check the help center before trading.

The engine uses these to:
  - end every intraday holding period at the 16:00 bar close (positions are auto-closed at 16:10 New York),
  - mark rules that hold overnight as not tradable in this account,
  - size positions within the contract cap and the loss limits,
  - simulate each strategy's evaluation: how often it reaches the target before breaching the max loss limit.
"""
import math
import random

import numpy as np

ACCOUNT = {
    "id": "mffu-builder-50k",
    "name": "MyFundedFutures 50K Builder",
    "checked": "2026-11-20",
    "source": "https://help.myfundedfutures.com/en/articles/14290805-builder-plan-50k-a-comprehensive-guide",
    "start": 50000,
    "target": 3000,
    "mll": {"default": 2000, "addon": 1500},     # end-of-day trailing max loss limit
    "lockAbove": 100,                            # the trailing floor stops at start + $100
    "dll": 1000,                                 # daily loss limit (soft pause: no more trading that day)
    "maxMinis": 4, "maxMicros": 40,
    "minDays": 1,
    "flat": "16:10",                             # auto-close, New York time; no overnight or weekend holds
    "opens": "18:00",
    "news": "unrestricted",
    "funded": {"buffer": {"default": 2100, "addon": 1600}, "minPayout": 500, "maxPayout": 2000,
               "bestDayShare": 0.5, "split": 0.8, "simPayouts": 5},
}
LAST_HOUR = 15          # the last hourly bar held is 15:00-16:00; the account is flattened at 16:10


def contracts(risk_usd, stop_pts, pv_micro, micro_cap=ACCOUNT["maxMicros"]):
    """Micro contracts for a risk budget and stop distance, within the account cap."""
    if not stop_pts or stop_pts <= 0:
        return 0
    return int(max(0, min(micro_cap, math.floor(risk_usd / (stop_pts * pv_micro)))))


def evaluate(day_pts, stops, pv_micro, risk_usd, plan="default", runs=2000, max_days=60, seed=11, baseline=True):
    """Monte Carlo of the evaluation for one strategy.

    day_pts: per-trading-day net points for one contract (0 on days without a trade), in time order.
    stops:   per-day stop distance in points on trade days (None on other days); sizes each day's trade.
    Days are drawn in random 5-day blocks from the strategy's own history. A day's loss is capped at the daily
    loss limit (the soft pause stops trading). The max loss limit trails the best end-of-day balance and locks at
    start + $100. Returns pass and breach rates within max_days and the median days to pass.
    """
    rnd = random.Random(seed)
    n = len(day_pts)
    if n < 30:
        return None
    mll0 = ACCOUNT["mll"][plan]
    start, target, dll = ACCOUNT["start"], ACCOUNT["target"], ACCOUNT["dll"]
    lock = start + ACCOUNT["lockAbove"]
    trade_days = [i for i in range(n) if stops[i]]
    if not trade_days:
        return None
    # sizing per trade from its own stop
    usd = np.zeros(n)
    sized = []
    for i in trade_days:
        k = contracts(risk_usd, stops[i], pv_micro)
        usd[i] = max(-dll, day_pts[i] * pv_micro * k)
        sized.append(k)
    if not any(sized):
        typical = float(np.median([stops[i] for i in trade_days]))
        return {"risk": risk_usd, "plan": plan, "micros": 0, "unsizeable": True,
                "microRiskUsd": round(typical * pv_micro), "dll": dll}
    res = _simulate(usd, n, rnd, runs, max_days, start, target, lock, mll0)
    out = {"risk": risk_usd, "plan": plan, "micros": int(np.median(sized)) if sized else 0,
           "minMicros": int(min(sized)) if sized else 0, "maxMicros": int(max(sized)) if sized else 0,
           "zeroSize": round(float(np.mean([k == 0 for k in sized])), 3) if sized else None, **res}
    if baseline:
        # the same trades and sizes with the average profit removed: what luck alone achieves
        z = usd.copy()
        m = z[trade_days].mean()
        z[trade_days] -= m
        out["noEdge"] = _simulate(z, n, random.Random(seed + 1), runs, max_days, start, target, lock, mll0)
    return out


def _simulate(usd, n, rnd, runs, max_days, start, target, lock, mll0):
    passed = breached = 0
    days_to_pass = []
    for _ in range(runs):
        bal, peak, d = start, start, 0
        done = False
        while d < max_days and not done:
            b = rnd.randrange(0, n - 5)
            for i in range(b, b + 5):
                floor_ = min(lock, peak - mll0)
                bal += usd[i]
                d += 1
                if bal <= floor_:
                    breached += 1
                    done = True
                    break
                peak = max(peak, bal)
                if bal - start >= target:
                    passed += 1
                    days_to_pass.append(d)
                    done = True
                    break
                if d >= max_days:
                    break
    return {"pass": round(passed / runs, 3), "breach": round(breached / runs, 3),
            "neither": round(1 - (passed + breached) / runs, 3), "withinDays": max_days,
            "medianDays": int(np.median(days_to_pass)) if days_to_pass else None}


def evaluations(day_pts, stops, pv_micro):
    """Pass odds at a few risk levels, so the page can show the trade-off."""
    out = []
    for risk in (250, 500, 750, 1000):
        r = evaluate(day_pts, stops, pv_micro, risk)
        if r:
            out.append(r)
    return out
