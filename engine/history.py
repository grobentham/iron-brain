"""Long hourly history from Dukascopy's free datafeed (Nasdaq-100 index CFD and spot gold), as mid prices.

Only the years before the futures bars begin are needed (Yahoo futures cover mid-2024 onward), so this history is
static: it is downloaded once into the `history-data` branch of this repository by the History workflow, and the
desk workflow just reads it. Nothing here runs on the 15-minute schedule.

Dukascopy publishes one file of hourly candles per instrument, side and month:
  https://datafeed.dukascopy.com/datafeed/{INSTRUMENT}/{year}/{month-1:02d}/{BID|ASK}_candles_hour_1.bi5
Each record is 24 bytes: seconds from the month start, open, close, low, high (prices x 1000) and volume. Hours with
no trading are flat with zero volume and are dropped. Bid and ask are averaged into mid prices: bid quotes alone dip
when the spread widens around the daily 17:00 New York break and recover at the reopen, which looks like a price
pattern but is not one.
"""
import concurrent.futures as cf
import datetime as dt
import json
import lzma
import os
import struct
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache", "duka")
INSTRUMENTS = {"nq": "USATECHIDXUSD", "gold": "XAUUSD"}
SIDES = ("BID", "ASK")
START, END = (2010, 1), (2024, 12)
URL = "https://datafeed.dukascopy.com/datafeed/{inst}/{y}/{m:02d}/{side}_candles_hour_1.bi5"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"}


def months():
    y, m = START
    while (y, m) <= END:
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def path(m, side, y, mo):
    return os.path.join(CACHE, side.lower(), f"{m}_{y}-{mo:02d}.json")


def fetch(inst, y, m, side, tries=3):
    """{iso utc hour: [o,h,l,c]} for one side and month, or None if it could not be fetched."""
    url = URL.format(inst=inst, y=y, m=m - 1, side=side)
    base = dt.datetime(y, m, 1, tzinfo=dt.timezone.utc)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                body = r.read()
            out = {}
            raw = lzma.decompress(body) if body else b""
            for k in range(len(raw) // 24):
                t, o, c, lo, hi, v = struct.unpack(">5if", raw[k * 24:(k + 1) * 24])
                if v <= 0 or hi <= lo:
                    continue
                out[(base + dt.timedelta(seconds=t)).isoformat(timespec="minutes")] = [o / 1000, hi / 1000, lo / 1000,
                                                                                         c / 1000]
            return out
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return {}
        except Exception:
            pass
        time.sleep(10 * (i + 1))
    return None


def sync(budget_s=2700, workers=2, log=print):
    """Fetch missing month files, politely, until done or out of time. Returns how many are still missing."""
    jobs = [(m, inst, side, y, mo) for m, inst in INSTRUMENTS.items() for side in SIDES for y, mo in months()
            if not os.path.exists(path(m, side, y, mo))]
    log(f"history: {len(jobs)} month files missing")
    t0, done, failed = time.time(), 0, 0
    with cf.ThreadPoolExecutor(max_workers=workers) as pool:
        pending = list(jobs)
        futs = {}
        while pending or futs:
            while pending and len(futs) < workers and time.time() - t0 < budget_s:
                j = pending.pop(0)
                futs[pool.submit(fetch, j[1], j[3], j[4], j[2])] = j
            if not futs:
                break
            f = next(cf.as_completed(futs))
            m, inst, side, y, mo = futs.pop(f)
            bars = f.result()
            if bars is None:
                failed += 1
            else:
                os.makedirs(os.path.dirname(path(m, side, y, mo)), exist_ok=True)
                with open(path(m, side, y, mo), "w") as fh:
                    json.dump(bars, fh, separators=(",", ":"))
                done += 1
            if (done + failed) % 25 == 0:
                print(f"history: {done} fetched, {failed} failed, {int(time.time() - t0)}s", flush=True)
    left = sum(not os.path.exists(path(m, side, y, mo)) for m in INSTRUMENTS for side in SIDES for y, mo in months())
    log(f"history: fetched {done}, failed {failed}, still missing {left}")
    return left


def load(m):
    """Cached hourly mid-price bars for a market: {iso utc: [o,h,l,c]}, or {} until every month has both sides
    (a partial history would leave gaps in the daily scale and profile)."""
    out = {}
    for y, mo in months():
        pb, pa = path(m, "BID", y, mo), path(m, "ASK", y, mo)
        if not (os.path.exists(pb) and os.path.exists(pa)):
            return {}
        bid, ask = json.load(open(pb)), json.load(open(pa))
        for t, b in bid.items():
            a = ask.get(t)
            if a:
                out[t] = [round((x + z) / 2, 4) for x, z in zip(b, a)]
    return out


if __name__ == "__main__":
    sys.exit(0 if sync() == 0 else 0)
