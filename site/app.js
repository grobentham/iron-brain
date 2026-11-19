/* Iron Brain intraday desk. Reads data/desk.json (engine/desk.py) and Displace's daily bias; all odds are worked
   out here from the current price and New York time. */
(function () {
  "use strict";
  var D = null, B = null, cur = "nq", live = {}, manual = {};
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var pc = function (p) { return p == null || !isFinite(p) ? "—" : (p < 0.01 && p > 0 ? "<1%" : p > 0.99 && p < 1 ? ">99%" : Math.round(p * 100) + "%"); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  };
  cur = store.get("ib-market") || "nq";

  function fmt(x, v) {
    if (!isFinite(x)) return "—";
    return Number(x).toLocaleString("en-US", { minimumFractionDigits: v.dp, maximumFractionDigits: v.dp });
  }
  function pts(x, v) { return fmt(x, v).replace(/\.0+$/, ""); }
  function roundTick(x, v) { return Math.round(x / v.tick) * v.tick; }

  /* ---- New York clock ---- */
  var NYF = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  function ny(t) {
    var p = {};
    NYF.formatToParts(t).forEach(function (x) { p[x.type] = x.value; });
    return { wd: p.weekday, date: p.year + "-" + p.month + "-" + p.day, h: Number(p.hour) % 24, m: Number(p.minute) };
  }
  function dayKey(t) { return ny(new Date(t.getTime() + 6 * 3600e3)).date; }
  function closed(n) {
    if (n.wd === "Sat") return true;
    if (n.wd === "Sun" && n.h < 18) return true;
    if (n.wd === "Fri" && n.h >= 17) return true;
    return n.h === 17;
  }

  /* ---- the model ---- */
  function surv(arr, grid, x) {
    if (!(x > 0)) return 1;
    var step = grid[1] - grid[0], i = x / step;
    if (i >= arr.length - 1) return arr[arr.length - 1] * Math.exp(-(i - arr.length + 1) * step * 3);
    var lo = Math.floor(i), f = i - lo;
    return arr[lo] * (1 - f) + arr[lo + 1] * f;
  }
  function inverse(arr, grid, p) {
    for (var i = 1; i < arr.length; i++) if (arr[i] <= p) {
      var f = (arr[i - 1] - p) / Math.max(1e-9, arr[i - 1] - arr[i]);
      return grid[i - 1] + f * (grid[i] - grid[i - 1]);
    }
    return grid[grid.length - 1];
  }
  function state(v, price, t) {
    var n = ny(t), w = v.profile, today = v.today, key = dayKey(t);
    if (closed(n)) return { closed: true, n: n };
    var j = (n.h - 18 + 24) % 24, rem = w[j] * (1 - n.m / 60);
    for (var k = j + 1; k < w.length; k++) rem += w[k];
    rem = Math.max(1e-4, rem);
    var done = Math.max(w[0] * 0.25, 1 - rem), sameDay = today && today.day === key;
    var hi = sameDay ? Math.max(today.high, price) : price, lo = sameDay ? Math.min(today.low, price) : price;
    var scale = today && today.scale;
    if (!scale) return { closed: true, n: n };
    var sig = scale * Math.sqrt(rem);
    var rho = hi > lo ? Math.log(hi / lo) / (scale * Math.sqrt(done)) : 1;
    rho = Math.min(3, Math.max(0.3, rho));
    var adj = Math.pow(rho, v.beta || 0);
    var ci = Math.min(w.length - 2, Math.max(0, n.m < 30 ? j - 1 : j));
    return { n: n, rem: rem, done: 1 - rem, sig: sig, rho: rho, adj: adj, hi: hi, lo: lo, sameDay: sameDay, price: price,
      open: sameDay ? today.open : null, up: table(v.survUp, ci), dn: table(v.survDn, ci) };
  }
  function table(t, i) { return Array.isArray(t[0]) ? t[i] : t; }
  function pTouch(v, S, level) {
    if (!(level > 0) || S.closed) return null;
    var up = level >= S.price, x = Math.abs(Math.log(level / S.price)) / S.sig / S.adj;
    return surv(up ? S.up : S.dn, v.grid, x);
  }

  /* ---- price source ---- */
  function priceOf(m) {
    var v = D.markets[m], q = live[m];
    if (manual[m] > 0) return { p: manual[m], src: "typed" };
    if (q && Date.now() - q.at < 120e3) return { p: q.price, src: "Live Bridge · " + q.symbol };
    var age = (Date.now() - new Date(v.today.lastTime).getTime()) / 60e3;
    return { p: v.today.last, src: "last bar " + v.today.lastTime.slice(11, 16) + " NY", stale: age > 40 && !closed(ny(new Date())), age: age };
  }

  /* ---- rendering ---- */
  function tabs() {
    $("tabs").innerHTML = Object.keys(D.markets).map(function (m) {
      var v = D.markets[m];
      return '<button role="tab" aria-selected="' + (m === cur) + '" data-m="' + m + '">' + esc(v.name) + "<small>" + esc(v.full) + "</small></button>";
    }).join("");
    Array.prototype.forEach.call($("tabs").querySelectorAll("button"), function (b) {
      b.onclick = function () { cur = b.getAttribute("data-m"); store.set("ib-market", cur); tabs(); desk(true); ctx(); testsView(); };
    });
  }

  function desk(rebuild) {
    var v = D.markets[cur]; if (!v) return;
    var P = priceOf(cur), S = state(v, P.p, new Date());
    if (rebuild || !$("ib-price")) {
      $("desk-body").innerHTML =
        '<div class="now"><label class="px"><small>Price</small><input id="ib-price" inputmode="decimal" autocomplete="off"></label>' +
        '<div class="px-src" id="ib-src"></div><button type="button" id="ib-reset" class="link">Use the latest bar</button></div>' +
        '<div id="ib-live"></div>' +
        '<div class="grid2"><div class="card"><h3>Touch before 17:00 New York</h3><div id="ib-ladder"></div>' +
        '<div class="custom"><label>Check a level <input id="ib-level" inputmode="decimal" placeholder="e.g. a stop or target"></label><div id="ib-level-out"></div></div></div>' +
        '<div class="card"><h3>Volatility through the day</h3><div id="ib-profile"></div><p class="fine">Share of a typical day’s movement in each hour (New York time). The highlighted bar is now.</p></div></div>';
      $("ib-price").onchange = $("ib-price").oninput = function () {
        var x = Number(String($("ib-price").value).replace(/,/g, ""));
        manual[cur] = x > 0 ? x : 0; desk(false);
      };
      $("ib-reset").onclick = function () { manual[cur] = 0; desk(true); };
      $("ib-level").oninput = function () { desk(false); };
    }
    if (document.activeElement !== $("ib-price")) $("ib-price").value = fmt(P.p, v).replace(/,/g, "");
    $("ib-src").innerHTML = esc(P.src) + (P.stale ? ' <b class="warn">· ' + Math.round(P.age) + " min old: type the live price</b>" : "");

    if (S.closed) {
      $("ib-live").innerHTML = '<div class="closed">Futures are closed. The day reopens at 18:00 New York time; odds resume then.</div>';
      $("ib-ladder").innerHTML = ""; $("ib-level-out").innerHTML = "";
      $("ib-profile").innerHTML = profileSvg(v, -1);
      return;
    }
    var remPts = S.price * S.sig, upMed = inverse(S.up, v.grid, 0.5) * S.adj * remPts, dnMed = inverse(S.dn, v.grid, 0.5) * S.adj * remPts;
    var pHi = S.sameDay ? pTouch(v, S, S.hi + v.tick) : null, pLo = S.sameDay ? pTouch(v, S, S.lo - v.tick) : null;
    var pace = S.rho > 1.15 ? "faster than usual" : S.rho < 0.87 ? "slower than usual" : "about usual";
    $("ib-live").innerHTML =
      '<div class="stats">' +
      stat("Day done", Math.round(S.done * 100) + "%", "of a typical day’s movement by " + pad(S.n.h) + ":" + pad(S.n.m) + " NY") +
      stat("Remaining range", pts(roundTick(remPts, v), v) + " pts", "typical, before pace") +
      stat("Pace", (S.sameDay ? S.rho.toFixed(2) + "×" : "—"), S.sameDay ? "today’s range so far is " + pace + (v.beta ? "" : " (not used)") : "no bars yet for today") +
      stat("Even odds", "+" + pts(roundTick(upMed, v), v) + " / −" + pts(roundTick(dnMed, v), v), "points above / below that are reached on half of days") +
      "</div>" +
      (S.sameDay ? '<div class="stats two">' +
        stat("New high today", pc(pHi), "above " + fmt(S.hi, v) + " before 17:00") +
        stat("New low today", pc(pLo), "below " + fmt(S.lo, v) + " before 17:00") + "</div>" : "");

    var rows = [], ks = [1, 0.75, 0.5, 0.25];
    ks.forEach(function (k) { rows.push(row("+" + frac(k), S.price * Math.exp(k * S.sig), v, S, "up")); });
    rows.push('<tr class="mid"><td>Price</td><td class="n">' + fmt(S.price, v) + '</td><td></td><td></td></tr>');
    ks.slice().reverse().forEach(function (k) { rows.push(row("−" + frac(k), S.price * Math.exp(-k * S.sig), v, S, "dn")); });
    $("ib-ladder").innerHTML = '<table class="ladder"><thead><tr><th>Step</th><th class="n">Level</th><th class="n">Away</th><th>Chance</th></tr></thead><tbody>' + rows.join("") + "</tbody></table>" +
      '<p class="fine">Steps are fractions of the remaining range. The chance a price is traded before the 17:00 close, from walk-forward tests since ' + esc(v.tests.from) + ".</p>";
    var L = Number(String($("ib-level").value || "").replace(/,/g, ""));
    if (L > 0) {
      var p = pTouch(v, S, L), d = L - S.price;
      $("ib-level-out").innerHTML = "<b>" + pc(p) + "</b> chance of trading " + fmt(L, v) + " (" + (d >= 0 ? "+" : "−") + pts(Math.abs(d), v) + " pts) before 17:00. " +
        "One point is $" + v.pv + " on the full contract, $" + v.micro + " on the micro.";
    } else $("ib-level-out").innerHTML = "";
    $("ib-profile").innerHTML = profileSvg(v, (S.n.h - 18 + 24) % 24);
  }
  function frac(k) { return k === 1 ? "1" : k === 0.75 ? "¾" : k === 0.5 ? "½" : "¼"; }
  function pad(x) { return (x < 10 ? "0" : "") + x; }
  function stat(t, b, s) { return '<div class="stat"><small>' + esc(t) + "</small><b>" + b + "</b><span>" + esc(s) + "</span></div>"; }
  function row(lab, level, v, S, side) {
    var L = roundTick(level, v), p = pTouch(v, S, L);
    return '<tr><td>' + lab + '</td><td class="n">' + fmt(L, v) + '</td><td class="n">' + (side === "up" ? "+" : "−") + pts(Math.abs(L - S.price), v) +
      '</td><td class="bar ' + side + '"><i style="width:' + Math.round((p || 0) * 100) + '%"></i><span>' + pc(p) + "</span></td></tr>";
  }
  function profileSvg(v, now) {
    var w = v.profile, mx = Math.max.apply(null, w), W = 460, H = 120, bw = W / w.length;
    var bars = w.map(function (x, i) {
      var h = Math.max(1, (x / mx) * (H - 22));
      return '<rect x="' + (i * bw + 1).toFixed(1) + '" y="' + (H - 16 - h).toFixed(1) + '" width="' + (bw - 2).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" class="' + (i === now ? "now" : "") + '"><title>' + pad(v.hours[i]) + ":00 · " + (x * 100).toFixed(1) + "%</title></rect>";
    }).join("");
    var labs = v.hours.map(function (h, i) { return i % 3 === 0 ? '<text x="' + (i * bw + bw / 2).toFixed(1) + '" y="' + (H - 3) + '">' + pad(h) + "</text>" : ""; }).join("");
    return '<svg class="prof" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Volatility by hour">' + bars + labs + "</svg>";
  }

  /* ---- Displace context ---- */
  function ctx() {
    if (!B) { $("ctx").innerHTML = '<p class="muted">Displace’s daily bias isn’t reachable from here. <a href="/displace/#bias">Open it on Displace ›</a></p>'; return; }
    var v = B.markets && B.markets[cur], me = D.markets[cur];
    if (!v) { $("ctx").innerHTML = '<p class="muted">No Displace bias for this market.</p>'; return; }
    var lean = v.tier === "tested" ? '<span class="tag ' + v.bias + '">' + v.bias.toUpperCase() + "</span>" : '<span class="tag neutral">BASE RATE</span>';
    var lv = v.levels || {}, band = v.band || {}, rg = v.range || {};
    $("ctx").innerHTML = '<div class="stats">' +
      stat("Displace bias for " + esc(B["for"]), lean + " " + pc(v.p_up), v.tier === "tested" ? "tested signals" : "no tested lean: how often it closes up on any day") +
      stat("Expected day range", pts(roundTick(rg.points, me), me) + " pts", "80% of days " + pts(roundTick(rg.lo, me), me) + "–" + pts(roundTick(rg.hi, me), me)) +
      stat("Yesterday", fmt(lv.high, me) + " / " + fmt(lv.low, me), "high / low, close " + fmt(lv.close, me)) +
      stat("1σ close band", fmt(band.lo, me) + "–" + fmt(band.hi, me), "from yesterday’s close") +
      '</div><p class="fine">The daily forecast comes from Displace’s volatility model; the desk above works out where price can go from here within the day. <a href="/displace/#bias">Full daily bias ›</a></p>';
  }

  /* ---- tests ---- */
  function res(ok, mid) { return ok ? '<span class="pass">Passed</span>' : mid ? '<span class="mid">' + mid + "</span>" : '<span class="fail">Failed</span>'; }
  function testsView() {
    var v = D.markets[cur], T = v.tests, bars = D.bars;
    var byK = T.touch.byK.map(function (r) {
      return "<tr><td>" + frac(r.k) + "</td><td class=\"n\">" + pc(r.up[0]) + '</td><td class="n">' + pc(r.up[1]) + '</td><td class="n">' + pc(r.dn[0]) + '</td><td class="n">' + pc(r.dn[1]) + "</td></tr>";
    }).join("");
    var ex = T.extreme.map(function (e) {
      return "<tr><td>New " + e.side + " later in the day</td><td class=\"n\">" + (e.skill * 100).toFixed(1) + '%</td><td class="n">' + e.t.toFixed(1) + '</td><td class="n">' + (e.halves[0] * 100).toFixed(1) + " / " + (e.halves[1] * 100).toFixed(1) + "%</td><td>" + res(e.passed) + "</td></tr>";
    }).join("");
    var pace = T.pace;
    var hours = v.hourly.map(function (h) {
      return "<tr><td>" + pad(h.hour) + ':00</td><td class="n">' + pc(h.up) + '</td><td class="n">' + (h.bp >= 0 ? "+" : "") + h.bp.toFixed(1) + ' bp</td><td class="n">' + h.z.toFixed(1) + " / " + h.t.toFixed(1) + "</td><td>" + res(h.passed) + "</td></tr>";
    }).join("");
    var o = v.opening;
    $("tests-body").innerHTML =
      '<p class="sub">' + esc(v.name) + ": " + T.days + " test days (" + esc(T.from) + " to " + esc(T.to) + "), " + T.checkpoints.toLocaleString() + " hourly checkpoints.</p>" +
      '<div class="grid2"><div class="card"><h3>Touch odds: predicted vs actual</h3><table class="t"><thead><tr><th>Step</th><th class="n">Up said</th><th class="n">Up did</th><th class="n">Down said</th><th class="n">Down did</th></tr></thead><tbody>' + byK + "</tbody></table>" +
      '<p class="fine">Averaged over every test checkpoint. Calibrated odds match their outcomes.</p></div>' +
      '<div class="card"><h3>Calibration</h3>' + calib(T.touch.reliability) + '<p class="fine">Each dot groups predictions of similar size; on the line means they came true as often as stated.</p></div></div>' +
      '<div class="card"><h3>Model tests</h3><table class="t"><thead><tr><th>Test</th><th class="n">Skill</th><th class="n">t</th><th class="n">Halves</th><th>Result</th></tr></thead><tbody>' + ex +
      (T.byHour ? "<tr><td>Separate odds for each hour</td><td class=\"n\">" + (T.byHour.skill * 100).toFixed(1) + '%</td><td class="n">' + T.byHour.t.toFixed(1) + '</td><td class="n">' + (T.byHour.halves[0] * 100).toFixed(1) + " / " + (T.byHour.halves[1] * 100).toFixed(1) + "%</td><td>" + res(T.byHour.passed) + "</td></tr>" : "") +
      "<tr><td>Pace (today’s speed so far)</td><td class=\"n\">" + (pace.skill * 100).toFixed(1) + '%</td><td class="n">' + pace.t.toFixed(1) + '</td><td class="n">' + (pace.halves[0] * 100).toFixed(1) + " / " + (pace.halves[1] * 100).toFixed(1) + "%</td><td>" + res(pace.passed) + "</td></tr></tbody></table>" +
      '<p class="fine">Skill is the out-of-sample improvement in Brier score. New high/low odds are compared with the plain rate for that hour and need t ≥ ' + bars.extreme.toFixed(2) + "; Separate hourly odds and pace are each compared with the model without them and need t ≥ " + bars.pace.toFixed(2) + ". Every test needs positive skill in each half. These check the quality of the odds, not a trading edge." +
      (T.byHour ? " Worst gap at any single hour between the odds and what happened (½ step): " + Math.round((v.byHour ? T.byHour.worstHourGapByHour : T.byHour.worstHourGap) * 100) + " points" + (v.byHour ? "." : ", mostly late in the New York afternoon, where these odds run high.") : "") + "</p></div>" +
      '<div class="grid2"><div class="card"><h3>Hour-of-day direction</h3><div class="scroll"><table class="t"><thead><tr><th>Hour</th><th class="n">Up</th><th class="n">Average</th><th class="n">z / t</th><th>Result</th></tr></thead><tbody>' + hours + "</tbody></table></div>" +
      '<p class="fine">Passing needs |z| and |t| ≥ ' + bars.hour.toFixed(2) + " (5% split across every hour in both markets) and the same side in both halves.</p></div>" +
      '<div class="card"><h3>Opening range (09:30–10:00)</h3>' + (o.days ? '<p class="status ' + o.status + '">' + (o.status === "tested" ? "Tested" : "Collecting: " + o.days + " of " + o.need + " days") + "</p>" +
        '<table class="t"><tbody><tr><td>Broke the high by 16:00</td><td class="n">' + pc(o.breakHigh) + "</td></tr><tr><td>Broke the low</td><td class=\"n\">" + pc(o.breakLow) + "</td></tr><tr><td>Broke both</td><td class=\"n\">" + pc(o.both) + "</td></tr><tr><td>Closed above the range</td><td class=\"n\">" + pc(o.closeAbove) + "</td></tr><tr><td>Closed below the range</td><td class=\"n\">" + pc(o.closeBelow) + "</td></tr><tr><td>Median width</td><td class=\"n\">" + o.medianWidthBp + " bp</td></tr></tbody></table>" +
        '<p class="fine">From free 5-minute bars, which only go back about 60 days. Shown for reference; the desk doesn’t use them until ' + o.need + " days exist.</p>" : '<p class="muted">No 5-minute history yet.</p>') + "</div></div>";
  }
  function calib(rel) {
    if (!rel || !rel.length) return '<p class="muted">Not enough data.</p>';
    var W = 220, pad_ = 24, sc = function (x) { return pad_ + x * (W - 2 * pad_); };
    var dots = rel.map(function (r) { return '<circle cx="' + sc(r[0]).toFixed(1) + '" cy="' + (W - sc(r[1])).toFixed(1) + '" r="' + Math.max(3, Math.min(9, Math.sqrt(r[2]) / 25)).toFixed(1) + '"><title>said ' + pc(r[0]) + ", happened " + pc(r[1]) + " (" + r[2] + ")</title></circle>"; }).join("");
    return '<svg class="cal" viewBox="0 0 ' + W + " " + W + '" role="img" aria-label="Calibration chart"><line x1="' + pad_ + '" y1="' + (W - pad_) + '" x2="' + (W - pad_) + '" y2="' + pad_ + '"/><text x="' + pad_ + '" y="' + (W - 6) + '">0%</text><text x="' + (W - pad_ - 18) + '" y="' + (W - 6) + '">100%</text>' + dots + "</svg>";
  }

  /* ---- Live Bridge ---- */
  function symMarket(s) {
    s = String(s || "").toUpperCase();
    if (/^(M?NQ|NAS100|US100|USTEC)/.test(s)) return "nq";
    if (/^(M?GC|XAU|GOLD)/.test(s)) return "gold";
    return null;
  }
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.source !== "iron-brain-bridge") return;
    var qs = e.data.quotes || [];
    qs.forEach(function (q) { var m = symMarket(q.symbol); if (m && q.price > 0) live[m] = { price: q.price, symbol: q.symbol, at: Date.now() }; });
    $("bridge-state").textContent = qs.length ? "Live Bridge connected: " + qs.map(function (q) { return q.symbol + " " + q.price; }).join(", ") : "Live Bridge connected. Open an NQ or gold chart on TradingView.";
    $("bridge-state").className = "ok";
    if (D) desk(false);
  });

  /* ---- boot ---- */
  function load() {
    return fetch("data/desk.json?t=" + Date.now()).then(function (r) { return r.json(); }).then(function (d) {
      D = d;
      if (!D.markets[cur]) cur = Object.keys(D.markets)[0];
      $("updated").textContent = "Engine updated " + new Date(D.updated).toLocaleString() + ".";
    });
  }
  load().then(function () {
    tabs(); desk(true); testsView(); ctx();
    fetch("/displace/data/bias/current.json?t=" + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).then(function (b) { B = b; ctx(); }).catch(function () { ctx(); });
    setInterval(function () { desk(false); }, 15000);
    setInterval(function () { load().then(function () { desk(false); }); }, 300000);
  }).catch(function () { $("desk-body").innerHTML = '<p class="muted">The desk data isn’t available yet.</p>'; });
  window.IB = { state: state, pTouch: pTouch, surv: surv };
})();
