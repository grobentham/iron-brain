"""Open a GitHub issue when a tested or candidate signal changes, so GitHub notifies the repo owner.

Compares the freshly built site/data/desk.json with the one currently live on GitHub Pages. Needs GITHUB_TOKEN and
GITHUB_REPOSITORY (set by Actions); does nothing elsewhere.
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
NEW = os.path.join(os.path.dirname(HERE), "site", "data", "desk.json")
LIVE = "https://grobentham.github.io/iron-brain/data/desk.json"
NAMES = {"nq": "NQ", "gold": "Gold"}


def key(x):
    """What makes a signal new: its state (orders, then a fill), direction, entry time and trading day."""
    lv = x.get("live") or {}
    return (lv.get("state"), lv.get("dir"), lv.get("at"), lv.get("day") or lv.get("asOf"))


def changes(old, new):
    prev = {(x["market"], x["id"]): x for x in (old.get("lab") or {}).get("strategies", [])}
    out = []
    for x in (new.get("lab") or {}).get("strategies", []):
        if x.get("tier") not in ("tested", "candidate"):
            continue
        lv = x.get("live") or {}
        if lv.get("state") not in ("signal", "orders"):
            continue
        p = prev.get((x["market"], x["id"]))
        if p is not None and key(p) == key(x):
            continue
        out.append(x)
    return out


def text(x):
    lv = x["live"]
    tier = "Tested signal" if x["tier"] == "tested" else "Candidate (not fully tested)"
    title = f"[{tier}] {NAMES.get(x['market'], x['market'])} {x['name']}: {lv.get('dir')}"
    lines = [f"**{tier}.** {x['rule']}", ""]
    if lv.get("state") == "orders":
        title = f"[{tier}] {NAMES.get(x['market'], x['market'])} {x['name']}: place orders"
        lines.append(f"Buy stop {lv['buyStop']} (protective stop {lv['stopLong']}) and sell stop {lv['sellStop']} "
                     f"(protective stop {lv['stopShort']}), one cancels the other. Cancel if unfilled by "
                     f"{lv['cancelAt']} New York; flat by {lv['exitBy']}.")
    elif lv.get("entry"):
        lines.append(f"Entry {lv['entry']} at {lv.get('at')} New York, stop {lv.get('stop')}"
                     + (f", target {lv['target']}" if lv.get("target") else "") + f", out by {lv.get('exitBy')}.")
    else:
        lines.append(lv.get("note", ""))
    if lv.get("next"):
        lines.append(lv["next"])
    lines += ["", f"Backtest: t {x['t']}, beat {round(x['beatRandom'] * 100)}% of random runs, deflated Sharpe {x['dsr']}. "
              f"Forward record since {x['forward']['since']}: {x['forward']['trades']} trades.",
              "", "Research only, not advice. https://grobentham.github.io/iron-brain/#signals"]
    return title, "\n".join(lines)


def main():
    token, repo = os.environ.get("GITHUB_TOKEN"), os.environ.get("GITHUB_REPOSITORY")
    new = json.load(open(NEW))
    try:
        with urllib.request.urlopen(LIVE, timeout=30) as r:
            old = json.load(r)
    except Exception as e:
        print(f"alerts: live data unavailable ({e!r}); not alerting this run")
        return
    found = changes(old, new)
    print(f"alerts: {len(found)} new signal(s)")
    if not (token and repo):
        return
    for x in found:
        title, body = text(x)
        req = urllib.request.Request(f"https://api.github.com/repos/{repo}/issues", method="POST",
                                     data=json.dumps({"title": title, "body": body, "labels": ["signal"]}).encode(),
                                     headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"})
        try:
            urllib.request.urlopen(req, timeout=30)
            print(f"alerts: opened '{title}'")
        except Exception as e:
            print(f"alerts: could not open an issue ({e!r})", file=sys.stderr)


if __name__ == "__main__":
    main()
