"""Strategy lab tests: no look-ahead, honest fills, and random walks pass nothing."""
import datetime as dt
import math
import os
import random
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import desk as D  # noqa: E402
import lab as L  # noqa: E402
from test_desk import synthetic  # noqa: E402


def _days():
    b1, _ = synthetic(days=360, seed=11)
    rows = D.to_ny(b1)
    days = D.hourly_days(rows)
    R, s = D.scales(days)
    return days, s, rows


def test_no_look_ahead():
    days, s, _ = _days()
    w = L.profiles(days)
    rnd = random.Random(2)
    checked = 0
    for i in range(60, len(days)):
        for st in [x for x in L.STRATEGIES if x["kind"] == "intraday"]:
            plan = st["fn"](days[i], s[i], w[i])
            if not plan:
                continue
            k = plan[0]
            d, O, H, L_, C = days[i]
            # scramble everything from the entry bar's close onward: the decision must not change
            O2, H2, L2, C2 = O.copy(), H.copy(), L_.copy(), C.copy()
            for j in range(k, D.SLOTS):
                f = math.exp(rnd.gauss(0, 0.01))
                if j > k:
                    O2[j] *= f
                H2[j], L2[j], C2[j] = H2[j] * f * 1.01, L2[j] * f * 0.99, C2[j] * f
            again = st["fn"]((d, O2, H2, L2, C2), s[i], w[i])
            assert again and again[:2] == plan[:2], (st["id"], plan, again)
            checked += 1
    assert checked > 100


def test_fills_are_conservative():
    O = np.full(23, 100.0); H = np.full(23, 100.5); Lo = np.full(23, 99.5); C = np.full(23, 100.0)
    H[3], Lo[3] = 103, 97          # one bar hits both the stop and the target
    e, x, why, _ = L.simulate((None, O, H, Lo, C), (1, 1, 98.0, 102.0, 22))
    assert why == "stop" and x == 98.0, "both inside one bar counts as the stop"
    O[5] = 96; H[5] = 96.5; Lo[5] = 95; Lo[3] = 99
    H[3] = 100.5
    e, x, why, _ = L.simulate((None, O, H, Lo, C), (1, 1, 98.0, None, 22))
    assert why == "stop" and x == 96, "a gap through the stop fills at the open"


def test_daily_rules_use_only_past_closes():
    rnd = random.Random(4)
    c = np.exp(np.cumsum([rnd.gauss(0, 0.01) for _ in range(800)])) * 100
    dates = [str(dt.date(2020, 1, 1) + dt.timedelta(days=i)) for i in range(800)]
    for st in [x for x in L.STRATEGIES if x["kind"] == "daily"]:
        f = (lambda c_: st["fn"](c_, dates[:len(c_)])) if st["id"] == "turn-of-month" else st["fn"]
        full = f(c)
        part = f(c[:600])
        assert np.array_equal(full[:599], part[:599]), st["id"]


def test_random_walk_passes_nothing():
    days, s, rows = _days()
    rnd = random.Random(9)
    c = np.exp(np.cumsum([rnd.gauss(0.0002, 0.012) for _ in range(3000)])) * 5000
    d0 = dt.date(2013, 1, 2)
    daily, k = {}, 0
    while len(daily) < 3000:
        d = d0 + dt.timedelta(days=k)
        k += 1
        if d.weekday() < 5:
            x = float(c[len(daily)])
            daily[str(d)] = [x, x * 1.005, x * 0.995, x]
    res = L.run({m: (days, s, rows) for m in D.MARKETS}, {m: daily for m in D.MARKETS},
                dt.datetime(2026, 1, 5, 15, tzinfo=dt.timezone.utc), log=lambda *a: None)
    assert res["trials"] == 2 * len(L.STRATEGIES)
    assert not [x["id"] for x in res["strategies"] if x["passed"]]
    for x in res["strategies"]:
        assert x["live"]["state"] in ("waiting", "none", "signal", "no data"), x["live"]


if __name__ == "__main__":
    test_fills_are_conservative()
    test_no_look_ahead()
    test_daily_rules_use_only_past_closes()
    test_random_walk_passes_nothing()
    print("lab tests passed")
