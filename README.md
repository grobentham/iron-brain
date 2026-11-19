# Iron Brain

**Fitted to a MyFundedFutures 50K Builder account** (see `engine/account.py`): odds run to the 16:10 New York
flat time, strategies that hold overnight are research only, sizing respects the 40-micro cap and the loss limits, and
every tradable strategy shows its simulated evaluation pass rate next to what luck alone achieves.

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
Yahoo futures bars (hourly since mid-2024, 5-minute bars growing since September 2026), adds Yahoo's latest bars and,
once complete, the long Dukascopy history below, and publishes `site/data/desk.json`. The page does the live arithmetic in the browser. No keys, no server, no model API.

- **Unit:** the expected remaining range, the day's typical range (20-day exponential average) times the share of
  daily movement still to come according to the hourly volatility profile.
- **Touch odds:** for every hour of every past day, how far price went above and below that hour's close before
  17:00 in those units, kept separately for up and down moves.
- **By hour:** late in the day, with a bar or two left, moves fall short of a single shared distribution. Each hour
  can get its own (pooled with its neighbours), used only where that beats the shared version out of sample. As of
  November 2026 it passes for NQ (worst hourly gap 16 → 5 points) but not gold, whose afternoon odds run high by up
  to about 11 points; the page says so.
- **Pace:** today's range so far versus what the profile expected stretches or shrinks the remaining range. It is
  used only while it beats the plain model out of sample (Diebold–Mariano t, Bonferroni across markets) in both halves.
- **Tests:** expanding-window refits every 20 trading days, scored on the next 20. New high/low odds are compared
  with the plain rate for that hour; touch odds are checked for calibration. Hour-of-day direction effects are tested
  with a Bonferroni bar across all hours and both markets (none pass). The 09:30–10:00 opening range statistics are
  shown as "collecting" until 250 days of 5-minute bars exist.

As of November 2026 (about 420 test days): touch odds are calibrated within a point or two at every step, new
high/low odds beat the plain hourly rate by about 24% (Brier skill), and pace adds a small, significant improvement.

`python engine/test_desk.py` checks that random walks pass no hour-of-day test and get calibrated touch odds.

## The account

`engine/account.py` holds the MyFundedFutures 50K Builder rules (checked 2026-11-20 against MyFundedFutures' help
center): $3,000 target, $2,000 end-of-day trailing max loss ($1,500 on the Add-On) that locks at $50,100, $1,000
daily loss soft pause, 4 minis / 40 micros, positions auto-closed at 16:10 New York with no overnight or weekend
holding, news unrestricted. The page's account panel takes your balance, best end-of-day balance and today's P&L
and shows your room to each limit; the desk's level checker sizes a stop against them.

For each strategy the account can trade, the lab simulates the evaluation from the strategy's own history: micros at
the rule's stop for a given risk, the daily loss limit as a cap, the trailing max loss, 60 trading days. It reports
the pass and fail rates next to a no-edge baseline (the same trades with their average profit removed), because with
a $3,000 target and $2,000 drawdown even a coin flip passes fairly often.

As of November 2026 no strategy the account allows has passed testing, and none passes the simulated evaluation
clearly more often than luck. The two that pass (NQ's 200-day trend filter, gold's turn of the month) hold overnight;
their day-session versions, registered 2026-11-20, use stops too wide to size on this account.

## Strategy lab

`engine/lab.py` holds eleven trading rules registered on 19 November 2026 with fixed parameters, before any was
run: six intraday (range exhaustion fade, opening drive, overnight move fade, overnight drift long, late-day momentum,
fast trend day) and five daily (20-day momentum, buy the big down day, 200-day trend filter, turn of the month,
weekly reversal). Each runs on NQ and gold, so 22 tests share one multiple-testing bar.

- Intraday rules decide on completed hourly bars, enter at the next bar's open, check stops before targets inside a
  bar (a gap through the stop fills at the open) and are flat by 17:00. Daily rules trade close to close.
- Costs: NQ 0.75 points and gold 0.3 points per round trip.
- To pass: t of daily net returns past the one-sided Bonferroni bar (2.84 for 22 tests), beat 95% of 200 random-timing
  runs of the same rule, profit in both halves and over the last 250 days, and enough trades. The deflated Sharpe
  ratio is reported but not required: on top of Bonferroni it counted the multiple testing twice.
- Every test reports the smallest annual Sharpe its sample could reliably detect and the 95% range of its own Sharpe,
  so the verdict separates **passed**, **promising** (every check holds and t ≥ 1.96, but not past the bar),
  **inconclusive** (the data can't rule a worthwhile edge in or out) and **no edge** (negative, or the whole range is
  below a Sharpe of 0.5).
- Every trade after the registration date is a forward record, recomputed from data on every run. Changes to the
  testing method are listed on the page; the rules themselves are never edited.

As of November 2026 two pass: NQ's 200-day trend filter (Sharpe 0.68) and gold's turn of the month (Sharpe 0.89).
The intraday rules are mostly inconclusive: 2.4 years of futures bars can only detect an annual Sharpe of about 2.4.

### Long intraday history

`engine/history.py` downloads Dukascopy's free hourly candles (Nasdaq-100 index CFD and spot gold) for 2010–2024,
bid and ask, and averages them into mid prices: bid quotes alone dip when the spread widens around the 17:00 break
and recover at the reopen, which shows up as a fake "gold rises at 18:00" effect. The History workflow builds this
once into the `history-data` branch (Dukascopy throttles, so it runs hourly until complete); the desk reads it and
uses it only for days before the futures bars begin, and only once a market's history is complete. Gold uses it from
2010 and NQ from 2018 (the CFD skips overnight hours before then). Hourly moves match the futures with a correlation
of about 0.96.

`python engine/test_lab.py` checks that rules never use future bars, that fills are conservative, and that random
walks pass nothing.

### Quant library (registered 2026-11-20)

Seven intraday rules from the research a quant desk would start with, all flat at 16:00 and sized from the expected
remaining range: opening-range breakout (and the same on active days), intraday momentum after Gao, Han, Li and Zhou
(2018), mean reversion in volatility units, an 8-hour volatility channel breakout, the 60-day trend traded in the day
session, and a walk-forward L2-regularised logistic regression on six volatility-scaled features. An equal-risk
ensemble of every intraday rule the account allows is tested as one more strategy (41 tests, bar t ≥ 3.04).

Breakouts fill with resting stop orders. Within the entry bar the standard path rule decides whether the stop came
after the fill (a bar that opened nearer its high went up first). Checking only the entry bar's close was optimistic:
it made random walks look profitable. On the 46 days with both hourly and 5-minute bars the hourly fills agree on the
trade's direction 98% of the time but are a little generous on NQ (about 9 points a trade against 4).

As of November 2026, on 2.4 years of intraday futures bars: the opening-range breakout is the strongest intraday
result (NQ Sharpe 1.0, gold 0.8, and in the 50K Builder simulation it passes about half of evaluations against a
quarter to a third for luck) but is inconclusive; the model and mean reversion show nothing. The long history should
settle it.

## Signals and alerts

The Signals panel at the top of the page has three tiers. **Tested** strategies passed every check and are the only
real signals. **Candidates** ("promising": every check holds and significant on its own, but not past the
multiple-testing bar) are shown as provisional signals with their next trigger, position size and forward record. As of November 2026 the tested signals are NQ's
200-day trend filter and gold's turn of the month. Everything else is **paper**, listed for the record.

The desk runs every 15 minutes while futures trade. GitHub's own cron is unreliable on new schedules, so the Ticker
workflow starts the desk on time and restarts itself; a 6-hourly cron revives it if the chain stops.

`engine/alerts.py` runs after each scheduled engine run and compares the new signals with the ones live on the site.
When a tested or candidate signal appears or changes, it opens an issue labelled `signal` in this repository, so
GitHub notifies the owner by email or the GitHub app.

## Live Bridge

`live-bridge/` is an optional Chrome/Opera extension that reads the symbol and price from TradingView tab titles so the
desk can use the live price. See its README.

## History

Until November 2026 this repository held ICT Brain, a TradingView screenshot analyzer built on ICT concepts. It was
removed because none of its setups had been tested against outcomes. It remains in the git history.

Research and education only. Not investment advice.
