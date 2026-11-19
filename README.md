# Iron Brain

The intraday desk for [Displace](https://grobentham.github.io/displace/): walk-forward tested session statistics for
NQ and gold futures, live at **https://grobentham.github.io/iron-brain/**.

From the current price and New York time the page shows:

- the chance of trading each level before the 17:00 close (steps of ¼ to 1 of the expected remaining range, plus any
  level you type, such as a stop or target),
- the chance the day still makes a new high or a new low,
- how much of a typical day's movement is done and how fast today is running,
- Displace's daily bias and range forecast for context.

## How it works

`engine/desk.py` runs in GitHub Actions every 15 minutes while futures trade. It reads Displace's archive of free
Yahoo futures bars (hourly since mid-2024, 5-minute bars growing since September 2026), adds Yahoo's latest bars, and
publishes `site/data/desk.json`. The page does the live arithmetic in the browser. No keys, no server, no model API.

- **Unit:** the expected remaining range, the day's typical range (20-day exponential average) times the share of
  daily movement still to come according to the hourly volatility profile.
- **Touch odds:** for every hour of every past day, how far price went above and below that hour's close before
  17:00 in those units, kept separately for up and down moves.
- **Pace:** today's range so far versus what the profile expected stretches or shrinks the remaining range. It is
  used only while it beats the plain model out of sample (Diebold–Mariano t, Bonferroni across markets) in both halves.
- **Tests:** expanding-window refits every 20 trading days, scored on the next 20. New high/low odds are compared
  with the plain rate for that hour; touch odds are checked for calibration. Hour-of-day direction effects are tested
  with a Bonferroni bar across all hours and both markets (none pass). The 09:30–10:00 opening range statistics are
  shown as "collecting" until 250 days of 5-minute bars exist.

As of November 2026 (about 420 test days): touch odds are calibrated within a point or two at every step, new
high/low odds beat the plain hourly rate by about 24% (Brier skill), and pace adds a small, significant improvement.

`python engine/test_desk.py` checks that random walks pass no hour-of-day test and get calibrated touch odds.

## Live Bridge

`live-bridge/` is an optional Chrome/Opera extension that reads the symbol and price from TradingView tab titles so the
desk can use the live price. See its README.

## History

Until November 2026 this repository held ICT Brain, a TradingView screenshot analyzer built on ICT concepts. It was
removed because none of its setups had been tested against outcomes. It remains in the git history.

Research and education only. Not investment advice.
