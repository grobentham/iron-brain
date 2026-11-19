"""Iron Brain desk tests: random walks must show no hour-of-day edge and calibrated touch odds."""
import datetime as dt
import json
import math
import os
import random
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import desk as D  # noqa: E402

# a U-shaped intraday volatility profile, like a real futures day
VOL = [0.6 if 18 <= h or h < 3 else 1.0 if h < 9 else 1.8 if h in (9, 10, 15) else 1.2 for h in D.SLOT_HOURS]


def synthetic(days=420, seed=3):
    rnd = random.Random(seed)
    bars1, bars5, px = {}, {}, 20000.0
    day = dt.date(2024, 7, 1)
    made = 0
    while made < days:
        if day.weekday() < 5:
            regime = math.exp(rnd.gauss(0, 0.3))
            start = dt.datetime.combine(day - dt.timedelta(days=1), dt.time(18), D.NY)
            for j in range(D.SLOTS):
                t = start + dt.timedelta(hours=j)
                o, h, lo = px, px, px
                for k in range(12):
                    nxt = px * math.exp(rnd.gauss(0, 0.0009 * VOL[j] * regime))
                    hi5, lo5 = max(px, nxt) * (1 + abs(rnd.gauss(0, 0.0002))), min(px, nxt) * (1 - abs(rnd.gauss(0, 0.0002)))
                    t5 = t + dt.timedelta(minutes=5 * k)
                    bars5[t5.astimezone(dt.timezone.utc).isoformat(timespec="minutes")] = [px, hi5, lo5, nxt]
                    h, lo, px = max(h, hi5), min(lo, lo5), nxt
                bars1[t.astimezone(dt.timezone.utc).isoformat(timespec="minutes")] = [o, h, lo, px]
            made += 1
        day += dt.timedelta(days=1)
    return bars1, bars5


def test_random_walk():
    b1, b5 = synthetic()
    with tempfile.TemporaryDirectory() as tmp:
        for m in D.MARKETS:
            json.dump({"bars": b1}, open(os.path.join(tmp, f"{m}_1h.json"), "w"))
            json.dump({"bars": b5}, open(os.path.join(tmp, f"{m}_5m.json"), "w"))
        out = os.path.join(tmp, "desk.json")
        doc = D.run(source=tmp, fresh=False, now=dt.datetime(2026, 1, 5, 15, tzinfo=dt.timezone.utc), out=out,
                    log=lambda *a: None)
        assert json.load(open(out))["markets"], "the page data is written"
    v = doc["markets"]["nq"]
    assert not any(h["passed"] for h in v["hourly"]), "a random walk has no hour-of-day edge"
    for row in v["tests"]["touch"]["byK"]:
        for side in ("up", "dn"):
            p, y = row[side]
            assert abs(p - y) < 0.04, (row, side)
    # the distance to today's extreme genuinely matters, even in a random walk
    assert all(e["skill"] > 0.05 for e in v["tests"]["extreme"])
    # the profile finds the busy New York hours
    w = v["profile"]
    assert w[D.SLOT_HOURS.index(9)] > 2 * w[D.SLOT_HOURS.index(22)]
    s = v["survUp"]
    assert s[0] > 0.9 and s[-1] < 0.05 and all(a >= b for a, b in zip(s, s[1:]))
    assert v["opening"]["status"] == "tested" and v["opening"]["days"] >= 250
    assert v["today"]["scale"] and v["today"]["high"] >= v["today"]["low"]


def test_helpers():
    S = D.survival([0.0, 1.0, 2.0, 3.0])
    assert S(0) > S(1.5) > S(10)
    assert D.z_needed(46) > 3.0 and D.t_needed(2) > 1.9
    rows = D.to_ny({"2026-01-05T15:00+00:00": [1, 2, 0.5, 1.5], "2026-01-05T16:00+00:00": [1, 1, 1, 1],
                    "2026-01-05T17:00+00:00": [1, 0.5, 2, 1]})
    assert len(rows) == 1


if __name__ == "__main__":
    test_helpers()
    test_random_walk()
    print("desk tests passed")
