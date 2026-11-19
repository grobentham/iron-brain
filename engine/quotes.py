"""Latest NQ and gold futures prices, for the page to pick up every minute.

Run by the Ticker workflow about once a minute while futures trade; it writes quotes.json, which the workflow
publishes on the `quotes` branch (one commit, replaced each time). Yahoo's futures prices are delayed about 10
minutes; for real-time prices the page uses Live Bridge (TradingView) when it is installed.
"""
import datetime as dt
import json
import sys
import urllib.request

import desk as D

URL = "https://query1.finance.yahoo.com/v8/finance/chart/{s}?range=2d&interval=1m"


def quote(m, now):
    res = D._get(URL.format(s=D.MARKETS[m]["symbol"]), tries=2)["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    key = D.day_key(now.astimezone(D.NY))
    last = hi = lo = t_last = None
    for t, h, l, c in zip(res["timestamp"], q["high"], q["low"], q["close"]):
        if c is None:
            continue
        ts = dt.datetime.fromtimestamp(t, dt.timezone.utc)
        if D.day_key(ts.astimezone(D.NY)) != key:
            continue
        last, t_last = c, ts
        if h is not None:
            hi = h if hi is None else max(hi, h)
        if l is not None:
            lo = l if lo is None else min(lo, l)
    meta = res.get("meta", {})
    if last is None:
        return None
    return {"price": round(float(last), 4), "time": t_last.isoformat(timespec="minutes"), "day": str(key),
            "high": round(float(hi), 4) if hi else None, "low": round(float(lo), 4) if lo else None,
            "marketPrice": meta.get("regularMarketPrice")}


def main(out="quotes.json"):
    now = dt.datetime.now(dt.timezone.utc)
    doc = {"updated": now.isoformat(timespec="seconds"), "source": "Yahoo Finance (CME futures, delayed about 10 min)",
           "markets": {}}
    for m in D.MARKETS:
        try:
            q = quote(m, now)
            if q:
                doc["markets"][m] = q
        except Exception as e:
            print(f"quotes: {m} unavailable ({e!r})", file=sys.stderr)
    with open(out, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    print("quotes: " + ", ".join(f"{m} {v['price']} @ {v['time'][11:16]}Z" for m, v in doc["markets"].items()))


if __name__ == "__main__":
    main(*sys.argv[1:])
