"""Long hourly history from Dukascopy's free datafeed (Nasdaq-100 index CFD and spot gold), cached per month.

Dukascopy publishes one small file of hourly candles per instrument per month:
  https://datafeed.dukascopy.com/datafeed/{INSTRUMENT}/{year}/{month-1:02d}/BID_candles_hour_1.bi5
Each record is 24 bytes: seconds from the month start, open, close, low, high (prices x 1000) and volume. Bid and
ask candles are both fetched and averaged into mid prices: bid quotes alone dip when the spread widens around the
daily 17:00 New York break and recover at the reopen, which looks like a price pattern but is not one.
Hours with no trading (weekends, breaks) are flat with zero volume and are dropped. Finished months are cached and
never fetched again; only the current month is refreshed.
"""
import concurrent.futures as cf
import datetime as dt
import json
import lzma
import os
import struct
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache", "duka-mid")
INSTRUMENTS = {"nq": "USATECHIDXUSD", "gold": "XAUUSD"}
START = (2010, 1)
URL = "https://datafeed.dukascopy.com/datafeed/{inst}/{y}/{m:02d}/{side}_candles_hour_1.bi5"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"}


def months(now):
    y, m = START
    while (y, m) <= (now.year, now.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def fetch_month(inst, y, m):
    """Mid-price candles for one month: the average of the bid and ask candles, so that the spread widening around
    the daily break does not show up as a fake price move. None if it could not be fetched."""
    bid, ask = fetch_side(inst, y, m, "BID"), fetch_side(inst, y, m, "ASK")
    if bid is None or ask is None:
        return None
    return {t: [round((b + a) / 2, 4) for b, a in zip(bid[t], ask[t])] for t in bid if t in ask}


def fetch_side(inst, y, m, side, tries=5):
    """{iso utc hour: [o,h,l,c]} of one side's candles for one month, or None if it could not be fetched."""
    url = URL.format(inst=inst, y=y, m=m - 1, side=side)
    base = dt.datetime(y, m, 1, tzinfo=dt.timezone.utc)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                body = r.read()
            out = {}
            raw = lzma.decompress(body) if body else b""
            for k in range(len(raw) // 24):
                t, o, c, lo, hi, v = struct.unpack(">5if", raw[k * 24:(k + 1) * 24])
                if v <= 0 or hi <= lo:
                    continue
                ts = (base + dt.timedelta(seconds=t)).isoformat(timespec="minutes")
                out[ts] = [o / 1000, hi / 1000, lo / 1000, c / 1000]
            return out
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return {}
        except Exception:
            pass
        time.sleep(min(20, 2 ** i))
    return None


def sync(now=None, log=print):
    """Fetch missing months (and always the current one) into the cache."""
    now = now or dt.datetime.now(dt.timezone.utc)
    os.makedirs(CACHE, exist_ok=True)
    jobs = []
    for m, inst in INSTRUMENTS.items():
        for y, mo in months(now):
            path = os.path.join(CACHE, f"{m}_{y}-{mo:02d}.json")
            current = (y, mo) == (now.year, now.month) or (now - dt.datetime(y, mo, 1, tzinfo=dt.timezone.utc)).days < 40
            if current or not os.path.exists(path):
                jobs.append((m, inst, y, mo, path))
    got = failed = 0
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        futs = {pool.submit(fetch_month, inst, y, mo): (m, path) for m, inst, y, mo, path in jobs}
        for f in cf.as_completed(futs):
            m, path = futs[f]
            bars = f.result()
            if bars is None:
                failed += 1
                continue
            with open(path, "w") as fh:
                json.dump(bars, fh, separators=(",", ":"))
            got += 1
    log(f"history: fetched {got} month files ({failed} failed)")


def load(m):
    """All cached hourly bars for a market: {iso utc: [o,h,l,c]}."""
    out = {}
    if not os.path.isdir(CACHE):
        return out
    for name in sorted(os.listdir(CACHE)):
        if name.startswith(m + "_") and name.endswith(".json"):
            out.update(json.load(open(os.path.join(CACHE, name))))
    return out


if __name__ == "__main__":
    sync()
