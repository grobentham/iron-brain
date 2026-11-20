"""Combinations of the opening-range breakout (v1) and the opening drive, written down before any were run
(2026-11-20). Discovery on NQ to 2022 and gold to 2019; holdout after, as in mutate.py and discover.py."""
import math, sys, random
import numpy as np
import desk as D, lab as L, mutate as M, discover as X
from statistics import NormalDist
S = L.slot
K10 = S(10)


def drive_dir(day, s, th=0.25):
    O, C = day[1], day[4]
    m = math.log(C[K10 - 1] / O[K10 - 1])
    return (1 if m > 0 else -1) if abs(m) >= th * s else 0


def first_hour_dir(day):
    O, C = day[1], day[4]
    return 1 if C[K10 - 1] > O[K10 - 1] else -1 if C[K10 - 1] < O[K10 - 1] else 0


def rem(w, s, k):
    return math.sqrt(max(1e-9, w[k:D.LAST + 1].sum())) * s


def orb(day, allow, stop_kind="mid", last=S(15)):
    _, O, H, Lw, C = day
    hi, lo = H[K10 - 1], Lw[K10 - 1]
    if not hi > lo:
        return None
    mid = (hi + lo) / 2
    for j in range(K10, last + 1):
        up, dn = L.first_side(O, H, Lw, j, hi, lo, allow)
        if up:
            return j, 1, mid if stop_kind == "mid" else lo, None, D.LAST, hi
        if dn:
            return j, -1, mid if stop_kind == "mid" else hi, None, D.LAST, lo
    return None


def drive(day, s, w):
    d = drive_dir(day, s)
    if not d:
        return None
    return K10, d, day[1][K10] * math.exp(-d * 0.5 * rem(w, s, K10)), None, D.LAST


VARIANTS = {
    # 1. breakout only in the direction the 09:00 hour closed
    "orb-with-hour": (lambda i, P: orb(P["days"][i], (first_hour_dir(P["days"][i]),)),
                      "Breakout (v1) only in the direction the 09:00-10:00 hour closed."),
    # 2. breakout only on drive days, in the drive's direction (a stop order instead of buying at 10:00)
    "orb-on-drive": (lambda i, P: orb(P["days"][i], (drive_dir(P["days"][i], P["s"][i]),)) if drive_dir(P["days"][i], P["s"][i]) else None,
                     "On opening-drive days only, a stop order beyond the 09:00 range in the drive's direction."),
    # 3. drive on drive days, breakout (both sides) on the other days
    "drive-else-orb": (lambda i, P: drive(P["days"][i], P["s"][i], P["w"][i]) or orb(P["days"][i], (1, -1)),
                       "Opening drive when it qualifies; on other days, the breakout (v1)."),
    # 4. drive entry with the breakout's stop: the far side of the 09:00 range
    "drive-range-stop": (lambda i, P: (lambda d: None if not d else (K10, d, P["days"][i][3][K10 - 1] if d > 0 else P["days"][i][2][K10 - 1], None, D.LAST))(drive_dir(P["days"][i], P["s"][i])),
                         "Opening drive, with the stop at the far side of the 09:00-10:00 range."),
    # 5. drive entry with the stop at the middle of the 09:00 range
    "drive-mid-stop": (lambda i, P: (lambda d: None if not d else (K10, d, (P["days"][i][2][K10 - 1] + P["days"][i][3][K10 - 1]) / 2, None, D.LAST))(drive_dir(P["days"][i], P["s"][i])),
                       "Opening drive, with the stop at the middle of the 09:00-10:00 range."),
}


def series(fn, P, m, idx):
    r, tr = X.run(fn, P, m, idx)
    return r, tr


def main():
    ND = NormalDist()
    rows = []
    for m in D.MARKETS:
        P = M.prepare(m, lambda *a: None)
        dates = [str(d[0]) for d in P["days"]]
        disc = [i for i, d in enumerate(dates) if d <= M.DISCOVERY_END[m]]
        hold = [i for i, d in enumerate(dates) if d > M.DISCOVERY_END[m]]
        base = {"orb": lambda i, P: orb(P["days"][i], (1, -1)),
                "drive": lambda i, P: drive(P["days"][i], P["s"][i], P["w"][i])}
        b = {k: (series(f, P, m, disc)[0], series(f, P, m, hold)[0]) for k, f in base.items()}
        for k, (rd, rh) in b.items():
            print(m, f"{k:18}", "disc", M.stats(rd, int((rd != 0).sum())), "| hold", M.stats(rh, int((rh != 0).sum())))
        # 6. both at equal risk, each scaled to the same volatility on the days it trades (discovery scale)
        sc = {k: 1 / np.std(v[0][v[0] != 0]) for k, v in b.items()}
        u = np.std(b["orb"][0][b["orb"][0] != 0])
        port = [sum(sc[k] * b[k][p] for k in b) / 2 * u for p in (0, 1)]
        print(m, f"{'both-half-risk':18}", "disc", M.stats(port[0], 0), "| hold", M.stats(port[1], 0),
              "corr", round(float(np.corrcoef(b['orb'][1], b['drive'][1])[0, 1]), 2))
        for vid, (fn, rule) in VARIANTS.items():
            rd, td = series(fn, P, m, disc)
            rh, th = series(fn, P, m, hold)
            rows.append((m, vid, M.stats(rd, len(td)), M.stats(rh, len(th)), rule))
    bar = ND.inv_cdf(1 - 0.05 / len(rows))
    print("holdout bar (all variants taken to the holdout)", round(bar, 2))
    for m, vid, sd, sh, rule in rows:
        print(f"{m:4} {vid:18} disc S {sd['sharpe']:5} t {sd['t']:5} n {sd['trades']:5} | hold S {sh['sharpe']:5} t {sh['t']:5} n {sh['trades']:4} halves {sh['halves']} {'PASS' if sh['t'] >= bar and min(sh['halves']) > 0 and sd['t'] > 0 else ''}")


if __name__ == "__main__":
    main()
