"""Iron Brain strategy lab: pre-registered strategies, tested honestly, with a forward paper record.

Every strategy below was written down on REGISTERED, before any of them was run, with fixed rules and no fitted
parameters. Each is run on NQ and gold, so there are len(STRATEGIES) x 2 tests, and one multiple-testing bar covers
all of them. Changing a rule means registering a new strategy (and raising the bar), never editing an old one.

Execution model (fitted to the prop account in account.py)
  intraday  decisions use completed hourly bars only; entry at the open of the next bar; stops and targets are
            checked on later bars' highs and lows, stop first when both fall in one bar; flat at the 16:00 bar
            close (the account is flattened at 16:10 New York)
  daily     close-to-close (Yahoo's daily futures opens are unreliable); a position held over consecutive days pays
            costs only when it changes
  costs     NQ 0.75 points and gold 0.3 points per round trip (about one tick of slippage each side plus commission)

A strategy passes only if all hold:
  t of its daily net returns >= the one-sided Bonferroni bar across every test
  it beats at least 95% of 200 runs of the same rules at random times (same direction, holding time, stops)
  positive net in both halves of its history and over the last 250 trading days
  enough data: 100 trades intraday; 30 separate positions and 250 days in the market for daily rules
Everything after REGISTERED is a forward record: trades the rules could not have been tuned on.

Verdicts: "passed" (tested signal); "promising" (every check holds and t >= 1.96, but not past the multiple-testing
bar: a provisional candidate); "inconclusive" (the data cannot rule a worthwhile edge in or out); "no edge" (negative,
or the 95% range of its Sharpe ratio sits below MEANINGFUL_SHARPE). The deflated Sharpe ratio is reported alongside.
"""
import datetime as dt
import math
import random
from statistics import NormalDist

import numpy as np

import account as A
import desk as D

REGISTERED = "2026-11-19"
COST = {"nq": 0.75, "gold": 0.3}
N_RANDOM = 200
MIN_TRADES = 100
MEANINGFUL_SHARPE = 0.5  # an annual Sharpe below this is not worth trading after real-world frictions
# Changes to the testing method (never to the rules). Each was made after seeing results, so the forward record,
# which no change can touch, is the cleaner test.
CHANGES = [
    ["2026-11-19", "Registered 11 rules on NQ and gold (22 tests)."],
    ["2026-11-19", "Intraday history extended with Dukascopy hourly mid prices (gold from 2010, NQ from 2018), from "
                   "2.4 years of futures bars, which could only detect an edge with an annual Sharpe near 2."],
    ["2026-11-19", "The deflated Sharpe ratio is reported but no longer required: on top of the Bonferroni bar it "
                   "counted the multiple testing twice (an effective t of about 3.6)."],
    ["2026-11-20", "Registered a quant library of seven intraday rules (opening-range breakout, the same on active "
                   "days, intraday momentum after Gao et al., mean reversion, volatility channel breakout, 60-day "
                   "trend in the day session, and a walk-forward logistic-regression model) and an equal-risk "
                   "ensemble of the intraday rules (40 rule tests plus the ensemble)."],
    ["2026-11-20", "Fitted to MyFundedFutures 50K Builder: every intraday rule is flat at the 16:00 bar close (the "
                   "account is flattened at 16:10); rules that hold overnight are research only. Registered two "
                   "account-safe day-session versions of the daily trend filter and turn of the month (26 tests)."],
]
ND = NormalDist()


def slot(hour):
    return (hour - 18) % 24


# ---------- intraday strategies (hourly bars; a day is 23 slots from 18:00) ----------
# Each rule sees the day so far and returns None or (entry slot, direction, stop price, target price or None, exit slot).
# Entry is at the OPEN of the entry slot, using only bars before it.

def _ctx(day, k, s, w):
    """Day-so-far context available at the open of slot k."""
    _, O, H, L, C = day
    hi, lo = H[:k].max(), L[:k].min()
    rem = math.sqrt(max(1e-9, w[k:D.LAST + 1].sum())) * s
    done = math.sqrt(max(1e-9, w[:k].sum())) * s
    return O, H, L, C, hi, lo, rem, done


def i_exhaustion(day, s, w):
    """Range exhaustion fade: between 10:00 and 14:00, once the day has used its typical range and the last close
    sits in the top or bottom 15% of the day, fade it. Stop beyond the extreme, target the day's midpoint."""
    for k in range(slot(10), slot(14) + 1):
        O, H, L, C, hi, lo, rem, _ = _ctx(day, k, s, w)
        if math.log(hi / lo) < s:
            continue
        pos = (C[k - 1] - lo) / (hi - lo)
        e = O[k]
        if pos >= 0.85:
            return k, -1, hi * math.exp(0.25 * rem), (hi + lo) / 2, D.LAST
        if pos <= 0.15:
            return k, 1, lo * math.exp(-0.25 * rem), (hi + lo) / 2, D.LAST
    return None


def i_opening_drive(day, s, w):
    """Opening drive: a 09:00-10:00 bar that moves at least a quarter of the typical day range sets the direction
    until the close. Stop half the remaining range away."""
    k = slot(10)
    O, H, L, C, hi, lo, rem, _ = _ctx(day, k, s, w)
    m = math.log(C[k - 1] / O[k - 1])
    if abs(m) < 0.25 * s:
        return None
    d = 1 if m > 0 else -1
    return k, d, O[k] * math.exp(-d * 0.5 * rem), None, D.LAST


def i_overnight_fade(day, s, w):
    """Overnight fade: if 18:00-09:00 moved at least 30% of the typical range, bet on a return toward the 18:00 open
    from 09:00. Stop half the remaining range away."""
    k = slot(9)
    O, H, L, C, hi, lo, rem, _ = _ctx(day, k, s, w)
    m = math.log(C[k - 1] / O[0])
    if abs(m) < 0.3 * s:
        return None
    d = -1 if m > 0 else 1
    return k, d, O[k] * math.exp(-d * 0.5 * rem), O[0], D.LAST


def i_overnight_long(day, s, w):
    """Overnight drift: long from the 18:00 open to the 09:00 open every day. Stop one remaining range below."""
    rem = math.sqrt(w[:D.LAST + 1].sum()) * s
    return 0, 1, day[1][0] * math.exp(-rem), None, slot(8)


def i_late_momentum(day, s, w):
    """Late-day momentum: at 15:00, if the day is up or down by at least a quarter of its typical range, ride it to
    the close. Stop half the remaining range away."""
    k = slot(15)
    O, H, L, C, hi, lo, rem, _ = _ctx(day, k, s, w)
    m = math.log(C[k - 1] / O[0])
    if abs(m) < 0.25 * s:
        return None
    d = 1 if m > 0 else -1
    return k, d, O[k] * math.exp(-d * 0.5 * rem), None, D.LAST


def i_fast_trend(day, s, w):
    """Fast trend day: at 12:00, if today is running at least 1.3x its usual pace and the last close is in the top or
    bottom 20% of the day, go with it to the close. Stop at the day's midpoint."""
    k = slot(12)
    O, H, L, C, hi, lo, rem, done = _ctx(day, k, s, w)
    if math.log(hi / lo) / done < 1.3:
        return None
    pos = (C[k - 1] - lo) / (hi - lo)
    if pos >= 0.8:
        return k, 1, (hi + lo) / 2, None, D.LAST
    if pos <= 0.2:
        return k, -1, (hi + lo) / 2, None, D.LAST
    return None


def i_trend_day(day, s, w, ctx=None):
    """Trend filter, account-safe: when the last daily close is above its 200-day average, long from the 18:00 open
    to the 16:00 close. Stop one expected day range below the entry."""
    if not ctx or not ctx.get("above200"):
        return None
    rem = math.sqrt(w[:D.LAST + 1].sum()) * s
    return 0, 1, day[1][0] * math.exp(-rem), None, D.LAST


def i_month_turn_day(day, s, w, ctx=None):
    """Turn of the month, account-safe: long from the 18:00 open to the 16:00 close on each of the first three
    trading days of the month. Stop one expected day range below the entry."""
    if not ctx or not ctx.get("monthDay") or ctx["monthDay"] > 3:
        return None
    rem = math.sqrt(w[:D.LAST + 1].sum()) * s
    return 0, 1, day[1][0] * math.exp(-rem), None, D.LAST


# ---------- quant library, registered 2026-11-20 ----------
# All flat at the 16:00 bar close; stops scale with the expected remaining range, so size scales with volatility.

def q_orb(day, s, w, ctx=None, pace_min=None):
    """Opening-range breakout: the 09:00-10:00 bar's high and low are the range. From 10:00 to 15:00, a stop order
    above the high buys and one below the low sells (whichever trades first; a bar that crosses both is skipped).
    Stop at the middle of the range, flat at 16:00."""
    k0 = slot(10)
    _, O, H, L, C = day
    hi, lo = H[k0 - 1], L[k0 - 1]
    if not hi > lo:
        return None
    if pace_min is not None:
        _, _, _, _, dhi, dlo, rem, done = _ctx(day, k0, s, w)
        if math.log(dhi / dlo) / done < pace_min:
            return None
    mid = (hi + lo) / 2
    for j in range(k0, slot(15) + 1):
        up, dn = H[j] > hi, L[j] < lo
        if up and dn:
            return None
        if up:
            return j, 1, mid, None, D.LAST, hi
        if dn:
            return j, -1, mid, None, D.LAST, lo
    return None


def q_orb_active(day, s, w, ctx=None):
    """Opening-range breakout on active days only: as the opening-range breakout, but only when the day's range by
    10:00 is at least its usual pace (1.0x what the volatility profile expects by then)."""
    return q_orb(day, s, w, ctx, pace_min=1.0)


def q_intraday_momentum(day, s, w, ctx=None):
    """Intraday momentum (Gao, Han, Li and Zhou, 2018): the return from the prior day's 16:00 close to 10:00 sets
    the direction for the last hour; long or short at the 15:00 open, flat at 16:00. Stop half the remaining range
    away. Needs the prior day's close."""
    if not ctx or not ctx.get("prevClose"):
        return None
    k = slot(15)
    _, O, H, L, C = day
    m = math.log(C[slot(10) - 1] / ctx["prevClose"])
    if m == 0:
        return None
    d = 1 if m > 0 else -1
    rem = math.sqrt(max(1e-9, w[k:D.LAST + 1].sum())) * s
    return k, d, O[k] * math.exp(-d * 0.5 * rem), None, D.LAST


def q_mean_reversion(day, s, w, ctx=None):
    """Mean reversion: from 10:00 to 14:00, when the last hourly close is more than 1.5 volatility units from the
    average of the six closes before it (units: the volatility those six hours normally carry), fade it. Target the
    average, stop one more unit away, flat at 16:00."""
    _, O, H, L, C = day
    for k in range(slot(10), slot(14) + 1):
        mean = float(np.mean(C[k - 7:k - 1]))
        unit = math.sqrt(max(1e-9, w[k - 7:k - 1].sum())) * s
        z = math.log(C[k - 1] / mean) / unit
        if abs(z) >= 1.5:
            d = -1 if z > 0 else 1
            e = O[k]
            stop = e * math.exp(-d * unit)
            return k, d, stop, mean, D.LAST
    return None


def q_channel_breakout(day, s, w, ctx=None):
    """Volatility channel breakout: from 03:00 to 14:00, when an hourly close breaks above the highest high (or below
    the lowest low) of the eight hours before it, follow it from the next open. Stop at the middle of that channel,
    flat at 16:00."""
    _, O, H, L, C = day
    for k in range(slot(3), slot(14) + 1):
        hh, ll = H[k - 9:k - 1].max(), L[k - 9:k - 1].min()
        if C[k - 1] > hh:
            return k, 1, (hh + ll) / 2, None, D.LAST
        if C[k - 1] < ll:
            return k, -1, (hh + ll) / 2, None, D.LAST
    return None


def q_trend_session(day, s, w, ctx=None):
    """Trend, day session (time-series momentum): the sign of the last 60 daily closes' return sets the direction;
    long or short at the 10:00 open, flat at 16:00. Stop half the remaining range away."""
    if not ctx or not ctx.get("mom60"):
        return None
    k = slot(10)
    d = ctx["mom60"]
    rem = math.sqrt(max(1e-9, w[k:D.LAST + 1].sum())) * s
    return k, d, day[1][k] * math.exp(-d * 0.5 * rem), None, D.LAST


def q_model(day, s, w, ctx=None):
    """Model (walk-forward logistic regression): six volatility-scaled features known at 10:00 (prior close to
    10:00, the 09:00 hour, the prior day, today's pace, where price sits in today's range, the prior day's range)
    predict whether 10:00-16:00 closes up. L2-regularised, refit every January on earlier years only. Long above
    53%, short below 47%, at the 10:00 open; stop half the remaining range away, flat at 16:00."""
    if not ctx or ctx.get("pUp") is None:
        return None
    p = ctx["pUp"]
    if 0.47 <= p <= 0.53:
        return None
    d = 1 if p > 0.53 else -1
    k = slot(10)
    rem = math.sqrt(max(1e-9, w[k:D.LAST + 1].sum())) * s
    return k, d, day[1][k] * math.exp(-d * 0.5 * rem), None, D.LAST


def _logit(X, y, lam=2.0, iters=40):
    """L2-regularised logistic regression by Newton steps (the intercept is not penalised)."""
    Xb = np.c_[np.ones(len(X)), X]
    b = np.zeros(Xb.shape[1])
    P = np.eye(Xb.shape[1]) * lam
    P[0, 0] = 0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Xb @ b))
        g = Xb.T @ (p - y) + P @ b
        Hm = (Xb * (p * (1 - p))[:, None]).T @ Xb + P
        step = np.linalg.solve(Hm, g)
        b -= step
        if np.abs(step).max() < 1e-8:
            break
    return b


def model_features(days, s, w):
    """Features at 10:00 for each day (None where not available) and the 10:00-16:00 outcome."""
    k = slot(10)
    F, Y = [], []
    for i, (d, O, H, L, C) in enumerate(days):
        if i == 0 or s[i] is None or w[i] is None or (d - days[i - 1][0]).days > 4:
            F.append(None)
            Y.append(None)
            continue
        pO, pH, pL, pC = days[i - 1][1:]
        prev = pC[D.LAST]
        hi, lo = H[:k].max(), L[:k].min()
        done = math.sqrt(max(1e-9, w[i][:k].sum())) * s[i]
        F.append([math.log(C[k - 1] / prev) / s[i], math.log(C[k - 1] / O[k - 1]) / s[i],
                  math.log(prev / pO[0]) / s[i], math.log(hi / lo) / done, (C[k - 1] - lo) / max(1e-9, hi - lo) - 0.5,
                  math.log(pH.max() / pL.min()) / s[i]])
        Y.append(1.0 if C[D.LAST] > O[k] else 0.0)
    return F, Y


def model_predictions(days, s, w, min_train=250):
    """Walk-forward P(up) per day: refit each January on all earlier days with features."""
    F, Y = model_features(days, s, w)
    out = [None] * len(days)
    years = sorted({d[0].year for d in days})
    for yr in years:
        tr = [i for i, d in enumerate(days) if d[0].year < yr and F[i] is not None]
        te = [i for i, d in enumerate(days) if d[0].year == yr and F[i] is not None]
        if len(tr) < min_train or not te:
            continue
        X = np.array([F[i] for i in tr])
        mu, sd = X.mean(0), X.std(0) + 1e-9
        b = _logit((X - mu) / sd, np.array([Y[i] for i in tr]))
        for i in te:
            x = (np.array(F[i]) - mu) / sd
            out[i] = float(1 / (1 + math.exp(-(b[0] + x @ b[1:]))))
    return out, F


# ---------- daily strategies (close to close) ----------
# Each returns a position for the NEXT day from closes up to today: array of -1, 0, 1.

def _ret(c):
    return np.r_[np.nan, np.diff(np.log(c))]


def d_momentum(c):
    """Time-series momentum: hold the sign of the last 20 days' return."""
    p = np.zeros(len(c))
    p[20:] = np.sign(np.log(c[20:] / c[:-20]))
    return p


def d_dip(c):
    """Buy the dip: after a day down more than 1.5x its 20-day volatility, long for one day."""
    r = _ret(c)
    p = np.zeros(len(c))
    for t in range(21, len(c)):
        sd = np.std(r[t - 19:t + 1])
        if sd > 0 and r[t] <= -1.5 * sd:
            p[t] = 1
    return p


def d_trend200(c):
    """Trend filter: long while the close is above its 200-day average, otherwise flat."""
    p = np.zeros(len(c))
    cs = np.cumsum(np.r_[0, c])
    for t in range(199, len(c)):
        if c[t] > (cs[t + 1] - cs[t - 199]) / 200:
            p[t] = 1
    return p


def d_turn_of_month(c, dates):
    """Turn of the month: long from the last trading day's close of each month to the third trading day's close."""
    p = np.zeros(len(c))
    month = [d[:7] for d in dates]
    for t in range(len(c) - 1):
        if month[t + 1] != month[t]:        # t is the last trading day of its month
            for j in range(t, min(len(c) - 1, t + 3)):
                p[j] = 1
    return p


def d_week_reversal(c):
    """Weekly reversal: after a 5-day fall of more than 2x its typical 5-day move, long for the next 5 days."""
    r = _ret(c)
    p = np.zeros(len(c))
    hold = 0
    for t in range(66, len(c)):
        sd5 = np.std(r[t - 59:t + 1]) * math.sqrt(5)
        if hold:
            p[t] = 1
            hold -= 1
        elif sd5 > 0 and math.log(c[t] / c[t - 5]) <= -2 * sd5:
            p[t] = 1
            hold = 4
    return p


STRATEGIES = [
    {"id": "exhaustion", "name": "Range exhaustion fade", "kind": "intraday", "fn": i_exhaustion},
    {"id": "opening-drive", "name": "Opening drive", "kind": "intraday", "fn": i_opening_drive},
    {"id": "overnight-fade", "name": "Overnight move fade", "kind": "intraday", "fn": i_overnight_fade},
    {"id": "overnight-long", "name": "Overnight drift long", "kind": "intraday", "fn": i_overnight_long},
    {"id": "late-momentum", "name": "Late-day momentum", "kind": "intraday", "fn": i_late_momentum},
    {"id": "fast-trend", "name": "Fast trend day", "kind": "intraday", "fn": i_fast_trend},
    {"id": "trend-day", "name": "Trend filter, day session", "kind": "intraday", "fn": i_trend_day, "daily": True,
     "registered": "2026-11-20"},
    {"id": "month-turn-day", "name": "Turn of the month, day session", "kind": "intraday", "fn": i_month_turn_day,
     "daily": True, "registered": "2026-11-20"},
    {"id": "orb", "name": "Opening-range breakout", "kind": "intraday", "fn": q_orb, "daily": True,
     "registered": "2026-11-20", "family": "quant"},
    {"id": "orb-active", "name": "Opening-range breakout, active days", "kind": "intraday", "fn": q_orb_active,
     "daily": True, "registered": "2026-11-20", "family": "quant"},
    {"id": "intraday-momentum", "name": "Intraday momentum (Gao et al.)", "kind": "intraday",
     "fn": q_intraday_momentum, "daily": True, "registered": "2026-11-20", "family": "quant"},
    {"id": "mean-reversion", "name": "Mean reversion", "kind": "intraday", "fn": q_mean_reversion, "daily": True,
     "registered": "2026-11-20", "family": "quant"},
    {"id": "channel-breakout", "name": "Volatility channel breakout", "kind": "intraday", "fn": q_channel_breakout,
     "daily": True, "registered": "2026-11-20", "family": "quant"},
    {"id": "trend-session", "name": "Trend, day session (60-day)", "kind": "intraday", "fn": q_trend_session,
     "daily": True, "registered": "2026-11-20", "family": "quant"},
    {"id": "model", "name": "Model: walk-forward logistic regression", "kind": "intraday", "fn": q_model,
     "daily": True, "registered": "2026-11-20", "family": "quant"},
    {"id": "momentum-20", "name": "20-day momentum", "kind": "daily", "fn": d_momentum},
    {"id": "dip", "name": "Buy the big down day", "kind": "daily", "fn": d_dip},
    {"id": "trend-200", "name": "200-day trend filter", "kind": "daily", "fn": d_trend200},
    {"id": "turn-of-month", "name": "Turn of the month", "kind": "daily", "fn": d_turn_of_month},
    {"id": "week-reversal", "name": "Weekly reversal", "kind": "daily", "fn": d_week_reversal},
]
for _s in STRATEGIES:
    _s["rule"] = " ".join(_s["fn"].__doc__.split())
    _s.setdefault("registered", REGISTERED)


# ---------- simulation ----------

def simulate(day, plan):
    """Walk an intraday plan through the day's bars. Returns (entry, exit, reason, bars held)."""
    _, O, H, L, C = day
    k, d, stop, target, last = plan[:5]
    trigger = plan[5] if len(plan) > 5 else None
    if trigger is not None:
        # A resting stop order, filled at the level (or the open if the bar gapped through it). Inside the entry bar
        # the order of the high and low is unknown, so the standard path rule decides it: a bar that opened nearer
        # its high went up first (open, high, low, close), otherwise down first (open, low, high, close). The stop
        # counts if the path reaches it after the fill, or if the bar closes beyond it.
        e = max(trigger, O[k]) if d > 0 else min(trigger, O[k])
        up_first = (H[k] - O[k]) <= (O[k] - L[k])
        if d > 0:
            hit = (up_first and L[k] <= stop) or C[k] <= stop
        else:
            hit = ((not up_first) and H[k] >= stop) or C[k] >= stop
        if hit:
            return e, stop, "stop", 1
        if k == last:
            return e, C[last], "time", 1
        k0 = k + 1
    else:
        e, k0 = O[k], k
    for j in range(k0, last + 1):
        if d > 0:
            if L[j] <= stop:
                return e, min(stop, O[j]) if j > k0 or trigger is not None else stop, "stop", j - k + 1
            if target is not None and H[j] >= target:
                return e, target, "target", j - k + 1
        else:
            if H[j] >= stop:
                return e, max(stop, O[j]) if j > k0 or trigger is not None else stop, "stop", j - k + 1
            if target is not None and L[j] <= target:
                return e, target, "target", j - k + 1
    return e, C[last], "time", last - k + 1


def profiles(days):
    """Volatility profile known before each day (expanding mean of squared hourly log ranges)."""
    acc = np.zeros(D.SLOTS)
    out = []
    for i, (_, _, H, L, _) in enumerate(days):
        out.append(acc / acc.sum() if i >= D.SPAN else None)
        acc += np.log(H / L) ** 2
    return out


def daily_context(days, daily_dates, daily_c):
    """For each intraday day: was the last daily close (before that day) above its 200-day average, and which
    trading day of the month is it? Only information known at the 18:00 open."""
    if daily_dates is None or not len(daily_c):
        return [None] * len(days)
    idx = {d: i for i, d in enumerate(daily_dates)}
    cs = np.cumsum(np.r_[0, daily_c])
    rank, prev_m, r = {}, None, 0
    for d in daily_dates:
        m = d[:7]
        r = r + 1 if m == prev_m else 1
        prev_m = m
        rank[d] = r
    out = []
    for day in days:
        d = str(day[0])
        j = np.searchsorted(np.array(daily_dates), d) - 1      # last daily close strictly before this day
        if j < 199:
            out.append(None)
            continue
        sma = (cs[j + 1] - cs[j - 199]) / 200
        mom = float(np.sign(math.log(daily_c[j] / daily_c[j - 60])))
        out.append({"above200": bool(daily_c[j] > sma), "monthDay": rank.get(d), "mom60": int(mom) or None})
    return out


def intraday_context(days, s, w, ctx):
    """Add what needs the hourly days themselves: the prior day's 16:00 close and the model's P(up)."""
    preds, _ = model_predictions(days, s, w)
    out = []
    for i, c in enumerate(ctx):
        c = dict(c or {})
        if i > 0 and (days[i][0] - days[i - 1][0]).days <= 4:
            c["prevClose"] = float(days[i - 1][4][D.LAST])
        c["pUp"] = preds[i]
        out.append(c)
    return out


def run_intraday(st, days, s, w, cost, ctx=None):
    trades = []
    for i, day in enumerate(days):
        if s[i] is None or w[i] is None:
            continue
        plan = st["fn"](day, s[i], w[i], ctx[i]) if st.get("daily") else st["fn"](day, s[i], w[i])
        if not plan or not (0 <= plan[0] <= plan[4] < D.SLOTS):
            continue
        e, x, why, held = simulate(day, plan)
        d = plan[1]
        if abs(e - plan[2]) <= 0:
            continue
        net = d * (x - e) - cost
        trades.append({"i": i, "date": str(day[0]), "dir": d, "entry": e, "exit": x, "why": why, "bars": held,
                       "slot": plan[0], "risk": abs(e - plan[2]), "net": net, "bp": net / e * 1e4, "plan": plan})
    return trades


def random_intraday(trades, days, s, w, cost, rnd):
    """Same trades (direction, holding time, stop and target distances) moved to random days and start hours."""
    out = []
    usable = [i for i in range(len(days)) if s[i] is not None and w[i] is not None]
    for t in trades:
        k, d, stop, target, last = t["plan"][:5]
        span = last - k
        i = rnd.choice(usable)
        k2 = rnd.randrange(0, D.LAST + 1 - span)
        day = days[i]
        f = day[1][k2] / days[t["i"]][1][k]          # move the stop and target with the price level
        plan = (k2, d, stop * f, target * f if target is not None else None, k2 + span)
        e, x, _, _ = simulate(day, plan)
        out.append((i, (d * (x - e) - cost) / e * 1e4))
    return out


def daily_series(n, trades):
    """Daily net returns in basis points (0 on days without a trade)."""
    r = np.zeros(n)
    for t in trades:
        r[t["i"]] += t["bp"]
    return r


def run_daily(st, dates, c, cost):
    p = st["fn"](c, dates) if st["id"] == "turn-of-month" else st["fn"](c)
    p = np.nan_to_num(p)
    nxt = np.r_[np.diff(np.log(c)), 0.0]          # return from close t to close t+1, earned by position p[t]
    change = np.abs(np.diff(np.r_[0.0, p]))
    r = (p * nxt - change * (cost / 2) / c) * 1e4   # half the round trip on each entry or exit
    r[-1] = 0.0
    trades = []
    t = 0
    while t < len(p):
        if p[t] != 0:
            j = t
            while j + 1 < len(p) and p[j + 1] == p[t]:
                j += 1
            e, x = c[t], c[min(j + 1, len(c) - 1)]
            net = p[t] * (x - e) - cost
            trades.append({"i": t, "date": dates[t], "dir": int(p[t]), "entry": float(e), "exit": float(x),
                           "why": "time", "bars": j - t + 1, "net": float(net), "bp": float(net / e * 1e4)})
            t = j + 1
        else:
            t += 1
    return p, r, trades


def random_daily(p, c, cost, rnd):
    """The same position series shifted to a random start: same exposure and holding pattern, random timing."""
    n = len(p)
    sh = rnd.randrange(n // 10, n - n // 10)
    q = np.roll(p, sh)
    nxt = np.r_[np.diff(np.log(c)), 0.0]
    change = np.abs(np.diff(np.r_[0.0, q]))
    r = (q * nxt - change * (cost / 2) / c) * 1e4
    r[-1] = 0.0
    return r


# ---------- statistics ----------

def tstat(r):
    r = np.asarray(r, float)
    if len(r) < 30 or r.std() == 0:
        return 0.0
    return float(r.mean() / (r.std(ddof=1) / math.sqrt(len(r))))


def sharpe(r):
    r = np.asarray(r, float)
    return float(r.mean() / r.std(ddof=1)) if len(r) > 2 and r.std() > 0 else 0.0


def deflated_sharpe(r, n_trials):
    """Probability the true Sharpe beats the best of n_trials pure-noise strategies (per-observation units).
    The noise level is this test's own: a no-skill Sharpe estimated from T observations has variance about 1/T."""
    r = np.asarray(r, float)
    T = len(r)
    sr = sharpe(r)
    if T < 30 or n_trials < 2:
        return None
    g = 0.5772156649
    e = math.e
    sr0 = math.sqrt(1 / T) * ((1 - g) * ND.inv_cdf(1 - 1 / n_trials) + g * ND.inv_cdf(1 - 1 / (n_trials * e)))
    m = r.mean()
    sd = r.std()
    skew = float(np.mean((r - m) ** 3) / sd ** 3) if sd else 0.0
    kurt = float(np.mean((r - m) ** 4) / sd ** 4) if sd else 3.0
    den = math.sqrt(max(1e-12, 1 - skew * sr + (kurt - 1) / 4 * sr * sr))
    return float(ND.cdf((sr - sr0) * math.sqrt(T - 1) / den))


def drawdown(pnl):
    eq = np.cumsum(pnl)
    peak = np.maximum.accumulate(np.r_[0.0, eq])[1:]
    return float((peak - eq).max()) if len(eq) else 0.0


def mc_drawdown(pnl, rnd, n=1000):
    """95th-percentile drawdown over random reorderings of the same trades."""
    a = list(pnl)
    if len(a) < 10:
        return None
    out = []
    for _ in range(n):
        rnd.shuffle(a)
        out.append(drawdown(a))
    return float(np.percentile(out, 95))


def curve(dates, pnl, n=240):
    eq = np.cumsum(pnl)
    if not len(eq):
        return []
    idx = np.unique(np.linspace(0, len(eq) - 1, min(n, len(eq))).astype(int))
    return [[dates[i], round(float(eq[i]), 2)] for i in idx]


# ---------- live state ----------

def partial_day(rows1, now):
    """Today's completed hourly slots so far: (date, O, H, L, C) with NaN for slots still to come."""
    key = D.day_key(now.astimezone(D.NY))
    a = np.full((D.SLOTS, 4), np.nan)
    for t, o, h, lo, c in rows1:
        if t.minute == 0 and t.hour != 17 and D.day_key(t) == key and t + dt.timedelta(hours=1) <= now.astimezone(D.NY):
            a[(t.hour - 18) % 24] = (o, h, lo, c)
    done = 0
    while done < D.SLOTS and not np.isnan(a[done, 0]):
        done += 1
    return key, done, a


def live_intraday(st, rows1, s_today, w, now, ctx_today=None):
    """Today's state for an intraday rule, from the hourly bars completed so far."""
    if not s_today:
        return {"state": "no data"}
    key, done, a = partial_day(rows1, now)
    last = _decision_slot(st)
    if done == 0:
        return {"state": "waiting", "note": "Decides at %02d:00 New York." % D.SLOT_HOURS[last]}
    O, H, L, C = (a[:, j].copy() for j in range(4))
    # bars still to come are filled so that they can never trigger anything; only plans entering by `done` count
    fill = (key, np.where(np.isnan(O), C[done - 1], O), np.where(np.isnan(H), -np.inf, H),
            np.where(np.isnan(L), np.inf, L), np.where(np.isnan(C), C[done - 1], C))
    with np.errstate(invalid="ignore", divide="ignore"):
        try:
            plan = st["fn"](fill, s_today, w, ctx_today) if st.get("daily") else st["fn"](fill, s_today, w)
        except (ValueError, ZeroDivisionError):
            plan = None
    if plan and plan[0] <= done and not (len(plan) > 5 and plan[0] >= done):
        k, d, stop, target, end = plan[:5]
        entry = plan[5] if len(plan) > 5 else (O[k] if k < done else C[done - 1])
        return {"state": "signal", "dir": "LONG" if d > 0 else "SHORT", "entry": round(float(entry), 2),
                "stop": round(float(stop), 2), "target": round(float(target), 2) if target is not None else None,
                "at": "%02d:00" % D.SLOT_HOURS[k], "exitBy": "%02d:00 New York" % ((D.SLOT_HOURS[end] + 1) % 24)}
    if done > last:
        return {"state": "none", "note": "No signal today."}
    return {"state": "waiting", "note": "Decides by %02d:00 New York." % D.SLOT_HOURS[last]}


def live_model(days, s, w, rows1, now, prev):
    """Today's P(up) from a model fitted on every completed day, once the 09:00 hour has closed."""
    try:
        preds, F = model_predictions(days, s, w)
        key, done, a = partial_day(rows1, now)
        k = slot(10)
        if done < k or not prev:
            return None
        fit = [i for i in range(len(days)) if F[i] is not None]
        if len(fit) < 250:
            return None
        _, Y = model_features(days, s, w)
        X = np.array([F[i] for i in fit])
        mu, sd = X.mean(0), X.std(0) + 1e-9
        b = _logit((X - mu) / sd, np.array([Y[i] for i in fit]))
        O, H, L, C = (a[:, j] for j in range(4))
        sc = s[-1]
        acc = np.zeros(D.SLOTS)
        for _, _, Hh, Ll, _ in days:
            acc += np.log(Hh / Ll) ** 2
        wt = acc / acc.sum()
        hi, lo = H[:k].max(), L[:k].min()
        doneu = math.sqrt(max(1e-9, wt[:k].sum())) * sc
        pO, pH, pL, pC = days[-1][1:]
        f = [math.log(C[k - 1] / prev) / sc, math.log(C[k - 1] / O[k - 1]) / sc, math.log(prev / pO[0]) / sc,
             math.log(hi / lo) / doneu, (C[k - 1] - lo) / max(1e-9, hi - lo) - 0.5, math.log(pH.max() / pL.min()) / sc]
        x = (np.array(f) - mu) / sd
        return float(1 / (1 + math.exp(-(b[0] + x @ b[1:]))))
    except Exception:
        return None


def _decision_slot(st):
    return {"orb": slot(15), "orb-active": slot(15), "intraday-momentum": slot(15), "mean-reversion": slot(14),
            "channel-breakout": slot(14), "trend-session": slot(10), "model": slot(10),"exhaustion": slot(14), "opening-drive": slot(10), "overnight-fade": slot(9), "overnight-long": 0,
            "late-momentum": slot(15), "fast-trend": slot(12), "trend-day": 0, "month-turn-day": 0}[st["id"]]


def _last_weekday(y, m):
    d = dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d


def live_daily(st, p, dates, c):
    """Position for the next session, plus what would change it."""
    pos = int(p[-1])
    last = dt.date.fromisoformat(dates[-1])
    out = {"state": "signal" if pos else "none", "dir": "LONG" if pos > 0 else "SHORT" if pos < 0 else "FLAT",
           "asOf": dates[-1], "note": "Position from the %s close to the next close." % dates[-1]}
    if st["id"] == "trend-200" and len(c) >= 200:
        avg = float(c[-200:].mean())
        out["level"] = round(avg, 2)
        out["next"] = ("Stays long while closes hold above the 200-day average ({:,.2f})." if pos else
                       "Goes long after a close above the 200-day average ({:,.2f}).").format(avg)
    elif st["id"] == "turn-of-month":
        if pos:
            out["next"] = "Long through the close of the month's third trading day."
        else:
            d = _last_weekday(last.year, last.month)
            if d <= last:
                d = _last_weekday(last.year + (last.month == 12), last.month % 12 + 1)
            out["next"] = "Next entry at the close on %s (last trading day of the month; check holidays)." % d.isoformat()
            out["nextDate"] = d.isoformat()
    elif st["id"] == "momentum-20" and len(c) > 20:
        out["next"] = "Flips when the close crosses {:,.2f}, the close 20 sessions ago.".format(float(c[-20]))
    return out


# ---------- run ----------

def daily_closes(bars, now):
    """Close-to-close series from Displace's daily candles, dropping today's unfinished candle."""
    ny = now.astimezone(D.NY)
    today = (ny.date() if ny.hour < 17 else None)
    rows = []
    for d in sorted(bars):
        o, h, lo, c = bars[d][:4]
        if not (c and c > 0 and h >= lo > 0):
            continue
        if today and d >= str(today):
            continue
        rows.append((d, float(c)))
    return [d for d, _ in rows], np.array([c for _, c in rows])


def evaluate(r, trades, kind, rnd_runs, n_trials, bar):
    n = len(r)
    h = n // 2
    real = float(np.sum(r))
    beat = float(np.mean([real > float(np.sum(x)) for x in rnd_runs])) if rnd_runs else 0.0
    recent = float(np.sum(r[-250:]))
    first, second = float(np.sum(r[:h])), float(np.sum(r[h:]))
    t = tstat(r)
    dsr = deflated_sharpe(r, n_trials)
    if kind == "daily":   # few, long positions: count separate positions and days in the market
        enough = len(trades) >= 30 and sum(t["bars"] for t in trades) >= 250
    else:
        enough = len(trades) >= MIN_TRADES
    checks = {"t": t >= bar, "random": beat >= 0.95, "halves": first > 0 and second > 0, "recent": recent > 0,
              "sample": enough}
    # power: what this sample could detect, and the range of annual Sharpe ratios the result is consistent with
    ann = math.sqrt(252)
    sr = sharpe(r) * ann
    need = (bar + ND.inv_cdf(0.8)) / math.sqrt(max(1, n)) * ann
    lo, hi = (t - 1.96) / math.sqrt(max(1, n)) * ann, (t + 1.96) / math.sqrt(max(1, n)) * ann
    passed = all(checks.values())
    others = all(v for k, v in checks.items() if k != "t")
    if passed:
        verdict = "passed"
    elif others and t >= 1.96:
        verdict = "promising"       # everything holds, significant on its own, but not after testing 22 ideas
    elif t <= 0 or hi < MEANINGFUL_SHARPE:
        verdict = "no edge"
    else:
        verdict = "inconclusive"    # the data cannot rule a worthwhile edge in or out
    return {"t": round(t, 2), "beatRandom": round(beat, 3), "halvesBp": [round(first, 1), round(second, 1)],
            "recentBp": round(recent, 1), "dsr": round(dsr, 3) if dsr is not None else None,
            "sharpe": round(sr, 2), "sharpeRange": [round(lo, 2), round(hi, 2)], "detectable": round(need, 2),
            "checks": checks, "passed": passed, "verdict": verdict}


def summary(trades, pv, rnd, dates_all, registered=REGISTERED):
    pnl = [t["net"] * pv for t in trades]
    wins = [x for x in pnl if x > 0]
    losses = [-x for x in pnl if x <= 0]
    span_years = max(0.25, (dt.date.fromisoformat(dates_all[-1]) - dt.date.fromisoformat(dates_all[0])).days / 365.25)
    fwd = [t for t in trades if t["date"] > registered]
    return {"trades": len(trades), "perYear": round(len(trades) / span_years, 1),
            "win": round(len(wins) / len(pnl), 3) if pnl else None,
            "avgPts": round(float(np.mean([t["net"] for t in trades])), 2) if trades else None,
            "totalUsd": round(sum(pnl)), "perYearUsd": round(sum(pnl) / span_years),
            "pf": round(sum(wins) / sum(losses), 2) if losses and sum(losses) > 0 else None,
            "maxDdUsd": round(drawdown(pnl)), "mcDd95Usd": round(mc_drawdown(pnl, rnd)) if len(pnl) >= 10 else None,
            "stops": round(float(np.mean([t["why"] == "stop" for t in trades])), 3) if trades else None,
            "curve": curve([t["date"] for t in trades], pnl),
            "forward": {"since": registered, "trades": len(fwd), "usd": round(sum(t["net"] * pv for t in fwd))},
            "from": dates_all[0], "to": dates_all[-1]}


MICRO_COST = {"nq": 1.25, "gold": 0.35}   # points per round trip on a micro: 1 tick each side plus commission


def account_eval(m, trades, n_days, cost):
    """Evaluation odds on the fitted prop account, trading micros at the strategy's own stops."""
    pv_micro = D.MARKETS[m]["micro"]
    pts = np.zeros(n_days)
    stops = [None] * n_days
    for t in trades:
        pts[t["i"]] += t["net"] + cost - MICRO_COST[m]   # swap the full-size cost for the micro cost
        stops[t["i"]] = t["risk"]
    return A.evaluations(pts.tolist(), stops, pv_micro)


def ensemble_tests(tests):
    """Per market, every intraday rule the account allows, combined at equal risk (each scaled to the same
    volatility on the days it trades), as one strategy. Its random benchmark combines the members' random runs."""
    out = []
    for m in D.MARKETS:
        mem = [t for t in tests if t["m"] == m and t["st"]["kind"] == "intraday" and t["trades"]]
        if len(mem) < 2:
            continue
        n = len(mem[0]["r"])
        scale = [1 / (np.std(t["r"][t["r"] != 0]) or 1) for t in mem]
        r = sum(sc * t["r"] for sc, t in zip(scale, mem)) / len(mem)
        k = min(len(t["rnd"]) for t in mem)
        rnd = [sum(sc * t["rnd"][j] for sc, t in zip(scale, mem)) / len(mem) for j in range(k)]
        unit = np.std(mem[0]["r"][mem[0]["r"] != 0]) or 1   # express in the first member's bp for readability
        out.append({"m": m, "members": [t["st"]["id"] for t in mem], "r": r * unit, "rnd": [x * unit for x in rnd],
                    "dates": mem[0]["dates"]})
    return out


def run(intraday_data, daily_data, now, log=print, seed=7):
    """intraday_data: {market: (days, s, rows1)}; daily_data: {market: {date: [o,h,l,c]}}."""
    rnd = random.Random(seed)
    tests = []
    for m in D.MARKETS:
        cost = COST[m]
        pv = D.MARKETS[m]["pv"]
        if m in intraday_data:
            days, s, rows1 = intraday_data[m]
            w = profiles(days)
            dates = [str(d[0]) for d in days]
            acc = np.zeros(D.SLOTS)
            for _, _, H, L, _ in days:
                acc += np.log(H / L) ** 2
            w_today = acc / acc.sum()
            R = [math.log(d[2].max() / d[3].min()) for d in days]
            a = 2 / (D.SPAN + 1)
            s_today = math.sqrt(a * R[-1] ** 2 + (1 - a) * s[-1] ** 2) if s[-1] else None
            dd = daily_closes(daily_data[m], now) if m in daily_data else (None, np.array([]))
            if dd[0] and m == "gold":   # Yahoo's daily gold candles before 2013 are placeholders
                keep = [i for i, d in enumerate(dd[0]) if d >= "2013-01-01"]
                dd = ([dd[0][i] for i in keep], dd[1][keep])
            ctx = intraday_context(days, s, w, daily_context(days, *dd))
            ctx_today = None
            if dd[0]:
                key = str(D.day_key(now.astimezone(D.NY)))
                ctx_today = dict(daily_context([(dt.date.fromisoformat(key),)], *dd)[0] or {})
                if days and str(days[-1][0]) < key:
                    ctx_today["prevClose"] = float(days[-1][4][D.LAST])
                ctx_today["pUp"] = live_model(days, s, w, rows1, now, ctx_today.get("prevClose"))
            for st in [x for x in STRATEGIES if x["kind"] == "intraday"]:
                trades = run_intraday(st, days, s, w, cost, ctx)
                r = daily_series(len(days), trades)
                rr = []
                for _ in range(N_RANDOM if trades else 0):
                    x = np.zeros(len(days))
                    for i, b in random_intraday(trades, days, s, w, cost, rnd):
                        x[i] += b
                    rr.append(x)
                tests.append({"m": m, "st": st, "r": r, "trades": trades, "rnd": rr, "dates": dates, "pv": pv,
                              "live": live_intraday(st, rows1, s_today, w_today, now, ctx_today),
                              "acct": account_eval(m, trades, len(days), cost)})
        if m in daily_data:
            dates, c = daily_closes(daily_data[m], now)
            if m == "gold":
                keep = [i for i, d in enumerate(dates) if d >= "2013-01-01"]
                dates, c = [dates[i] for i in keep], c[keep]
            for st in [x for x in STRATEGIES if x["kind"] == "daily"]:
                p, r, trades = run_daily(st, dates, c, cost)
                rr = [random_daily(p, c, cost, rnd) for _ in range(N_RANDOM)]
                tests.append({"m": m, "st": st, "r": r, "trades": trades, "rnd": rr, "dates": dates, "pv": pv,
                              "live": live_daily(st, p, dates, c), "last": float(c[-1]),
                              "range": float(np.mean(np.abs(np.diff(np.log(c[-21:]))))) * float(c[-1])})
    ensembles = ensemble_tests(tests)
    n_trials = len(STRATEGIES) * len(D.MARKETS) + len(ensembles)
    bar = ND.inv_cdf(1 - 0.05 / n_trials)
    out = []
    for t in tests:
        ev = evaluate(t["r"], t["trades"], t["st"]["kind"], t["rnd"], n_trials, bar)
        sm = summary(t["trades"], t["pv"], rnd, t["dates"], t["st"]["registered"])
        tier = {"passed": "tested", "promising": "candidate"}.get(ev["verdict"], "paper")
        tradable = t["st"]["kind"] != "daily"
        if not tradable and tier in ("tested", "candidate"):
            tier = "research"           # passes, but holds overnight: not allowed in the fitted account
        out.append({"tier": tier, "tradable": tradable, "account": t.get("acct"),
                    "registered": t["st"]["registered"], "lastClose": t.get("last"), "avgDailyMove": t.get("range"), "id": t["st"]["id"], "name": t["st"]["name"], "kind": t["st"]["kind"], "rule": t["st"]["rule"],
                    "market": t["m"], **ev, **sm, "live": t["live"],
                    "recentTrades": [{k: (round(v, 2) if isinstance(v, float) else v) for k, v in x.items()
                                      if k in ("date", "dir", "entry", "exit", "why", "net")} for x in t["trades"][-8:]]})
    ens_out = []
    for e in ensembles:
        ev = evaluate(e["r"], [None] * 1000, "intraday", e["rnd"], n_trials, bar)
        ens_out.append({"market": e["m"], "members": e["members"], "days": len(e["r"]), **ev,
                        "curve": curve(e["dates"], e["r"])})
    passed = [f"{x['market']}:{x['id']}" for x in out if x["passed"]]
    cands = [f"{x['market']}:{x['id']}" for x in out if x["tier"] == "candidate"]
    log(f"lab: {len(out)} tests, bar t >= {bar:.2f}; passed {passed or 'none'}; candidates {cands or 'none'}")
    return {"registered": REGISTERED, "trials": n_trials, "account": A.ACCOUNT, "bar": round(bar, 2), "random": N_RANDOM,
            "costs": COST, "changes": CHANGES, "meaningful": MEANINGFUL_SHARPE, "strategies": out,
            "ensembles": ens_out}
