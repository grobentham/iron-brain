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
    var last = v.last != null ? v.last : w.length - 1, j = (n.h - 18 + 24) % 24;
    if (j > last) return { closed: true, n: n, flat: true };
    var rem = w[j] * (1 - n.m / 60);
    for (var k = j + 1; k <= last; k++) rem += w[k];
    rem = Math.max(1e-4, rem);
    var done = Math.max(w[0] * 0.25, 1 - rem), sameDay = today && today.day === key;
    var hi = sameDay ? Math.max(today.high, price) : price, lo = sameDay ? Math.min(today.low, price) : price;
    var scale = today && today.scale;
    if (!scale) return { closed: true, n: n };
    var sig = scale * Math.sqrt(rem);
    var rho = hi > lo ? Math.log(hi / lo) / (scale * Math.sqrt(done)) : 1;
    rho = Math.min(3, Math.max(0.3, rho));
    var adj = Math.pow(rho, v.beta || 0);
    var ci = Math.min(last - 1, Math.max(0, n.m < 30 ? j - 1 : j));
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
      b.onclick = function () { cur = b.getAttribute("data-m"); store.set("ib-market", cur); tabs(); desk(true); ctx(); labView(); testsView(); };
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
        '<div class="grid2"><div class="card"><h3>Touch before the 16:10 flat</h3><div id="ib-ladder"></div>' +
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
      $("ib-live").innerHTML = '<div class="closed">' + (S.flat ? "Your account is flat: MyFundedFutures closes positions at 16:10 New York. Trading reopens at 18:00." : "Futures are closed. The day reopens at 18:00 New York time; odds resume then.") + "</div>";
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
        stat("New high today", pc(pHi), "above " + fmt(S.hi, v) + " before 16:10") +
        stat("New low today", pc(pLo), "below " + fmt(S.lo, v) + " before 16:10") + "</div>" : "");

    var rows = [], ks = [1, 0.75, 0.5, 0.25];
    ks.forEach(function (k) { rows.push(row("+" + frac(k), S.price * Math.exp(k * S.sig), v, S, "up")); });
    rows.push('<tr class="mid"><td>Price</td><td class="n">' + fmt(S.price, v) + '</td><td></td><td></td></tr>');
    ks.slice().reverse().forEach(function (k) { rows.push(row("−" + frac(k), S.price * Math.exp(-k * S.sig), v, S, "dn")); });
    $("ib-ladder").innerHTML = '<table class="ladder"><thead><tr><th>Step</th><th class="n">Level</th><th class="n">Away</th><th>Chance</th></tr></thead><tbody>' + rows.join("") + "</tbody></table>" +
      '<p class="fine">Steps are fractions of the remaining range. The chance a price is traded before the 16:10 flat, from walk-forward tests since ' + esc(v.tests.from) + ".</p>";
    var L = Number(String($("ib-level").value || "").replace(/,/g, ""));
    if (L > 0) {
      var p = pTouch(v, S, L), d = L - S.price;
      var room = acctRoom(), perMicro = Math.abs(d) * v.micro, fit = room ? Math.max(0, Math.min(40, Math.floor(Math.min(room.risk, room.dll, room.mll) / perMicro))) : 0;
      $("ib-level-out").innerHTML = "<b>" + pc(p) + "</b> chance of trading " + fmt(L, v) + " (" + (d >= 0 ? "+" : "−") + pts(Math.abs(d), v) + " pts) before 16:10. " +
        (room ? "As a stop, each micro risks " + usd(perMicro) + ": <b>" + fit + "</b> micro" + (fit === 1 ? "" : "s") + " fit your risk and loss limits" + (fit >= 10 ? " (" + Math.floor(fit / 10) + " mini" + (fit >= 20 ? "s" : "") + ")" : "") + "." : "");
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

  /* ---- account (MyFundedFutures 50K Builder) ---- */
  function acctState() {
    var A = D.lab && D.lab.account; if (!A) return null;
    var st = {};
    try { st = JSON.parse(store.get("ib-acct") || "{}"); } catch (e) { st = {}; }
    return { A: A, plan: st.plan || "default", bal: st.bal != null ? st.bal : A.start, peak: st.peak != null ? st.peak : A.start, today: st.today || 0, risk: st.risk || 300 };
  }
  function acctRoom() {
    var s = acctState(); if (!s) return null;
    var A = s.A, mll = A.mll[s.plan], floor_ = Math.min(A.start + A.lockAbove, s.peak - mll);
    return { floor: floor_, mll: Math.max(0, s.bal - floor_), dll: Math.max(0, A.dll + Math.min(0, s.today)), risk: s.risk, toTarget: A.start + A.target - s.bal, s: s };
  }
  function acctView() {
    var s = acctState();
    if (!s) { $("acct-body").innerHTML = '<p class="muted">Account rules load with the strategy lab.</p>'; return; }
    var A = s.A, R = acctRoom();
    var rules = '<div class="stats">' +
      stat("Target", usd(A.target), "evaluation, at least " + A.minDays + " day, no consistency rule") +
      stat("Max loss", usd(A.mll[s.plan]), "trails your best end-of-day balance, locks at " + usd(A.start + A.lockAbove)) +
      stat("Daily loss", usd(A.dll), "soft pause: no more trading that day") +
      stat("Size and hours", A.maxMinis + " minis / " + A.maxMicros + " micros", "flat by " + A.flat + " New York, no overnight") + "</div>";
    var form = '<div class="acct-form"><label>Plan <select id="ac-plan"><option value="default"' + (s.plan === "default" ? " selected" : "") + '>Default ($2,000 max loss)</option><option value="addon"' + (s.plan === "addon" ? " selected" : "") + ">Add-On ($1,500 max loss)</option></select></label>" +
      '<label>Balance $<input id="ac-bal" inputmode="decimal" value="' + s.bal + '"></label>' +
      '<label>Best end-of-day balance $<input id="ac-peak" inputmode="decimal" value="' + s.peak + '"></label>' +
      '<label>Today’s P&amp;L $<input id="ac-today" inputmode="decimal" value="' + s.today + '"></label>' +
      '<label>Risk per trade $<input id="ac-risk" inputmode="decimal" value="' + s.risk + '"></label></div>';
    var warn = s.risk > R.dll ? '<p class="warn">Your risk per trade is more than what’s left of today’s daily loss limit.</p>' : s.risk > R.mll / 3 ? '<p class="warn">One loss at this size uses more than a third of your room to the max loss limit.</p>' : "";
    var room = '<div class="stats">' +
      stat("Room to max loss", usd(R.mll), "your account fails at " + usd(R.floor)) +
      stat("Room today", usd(R.dll), "before the daily soft pause") +
      stat("To the target", R.toTarget > 0 ? usd(R.toTarget) : "Reached", R.toTarget > 0 ? "of " + usd(A.target) : "request your sim funded account") +
      stat("Losses you can take", R.mll > 0 ? Math.floor(R.mll / Math.max(1, s.risk)) : 0, "full stop-outs at " + usd(s.risk) + " before failing") + "</div>";
    $("acct-body").innerHTML = '<p class="sub">Iron Brain is fitted to the <b>' + esc(A.name) + "</b>. Rules checked " + esc(A.checked) + ' from <a href="' + esc(A.source) + '">MyFundedFutures’ help center</a>; prop rules change, so confirm before trading. News trading is unrestricted on this plan.</p>' + rules + form + warn + room +
      '<p class="fine">Enter your numbers from the MyFundedFutures dashboard; they stay in this browser. The level checker on the desk sizes a stop against these limits.</p>';
    ["ac-plan", "ac-bal", "ac-peak", "ac-today", "ac-risk"].forEach(function (id) {
      $(id).onchange = function () {
        var o = { plan: $("ac-plan").value, bal: Number($("ac-bal").value) || A.start, peak: Number($("ac-peak").value) || A.start, today: Number($("ac-today").value) || 0, risk: Number($("ac-risk").value) || 300 };
        o.peak = Math.max(o.peak, A.start);
        store.set("ib-acct", JSON.stringify(o)); acctView(); desk(false);
      };
    });
  }
  function acctCell(x) {
    if (!x.tradable) return '<span class="muted" title="MyFundedFutures closes every position at 16:10 New York">not allowed: holds overnight</span>';
    var a = (x.account || []).filter(function (e) { return e.risk === 500; })[0] || (x.account || [])[0];
    if (!a) return "—";
    if (a.unsizeable) return '<span class="muted">stop too wide: 1 micro risks ' + usd(a.microRiskUsd) + "</span>";
    return "pass " + pc(a.pass) + " <small>(luck " + pc(a.noEdge && a.noEdge.pass) + ", fail " + pc(a.breach) + ")</small>";
  }

  /* ---- signals ---- */
  function signalsView() {
    var Lb = D.lab;
    if (!Lb) { $("sig-body").innerHTML = '<p class="muted">The strategy lab hasn’t run yet.</p>'; return; }
    var all = Lb.strategies, tested = all.filter(function (x) { return x.tier === "tested"; }), cand = all.filter(function (x) { return x.tier === "candidate"; }), research = all.filter(function (x) { return x.tier === "research"; });
    var paper = all.filter(function (x) { return x.tier === "paper" && x.live && x.live.state === "signal"; });
    var risk = Number(store.get("ib-risk") || 1000);
    var html = '<div class="sig-sum"><span><b>' + tested.length + "</b> tested</span><span><b>" + cand.length + "</b> candidate" + (cand.length === 1 ? "" : "s") + "</span><span><b>" + research.length + "</b> passed, not allowed</span><span><b>" + (all.length - tested.length - cand.length - research.length) + "</b> paper</span>" +
      '<label class="riskin">Risk per trade $<input id="sig-risk" inputmode="decimal" value="' + risk + '"></label></div>';
    html += '<h3 class="tier">Tested and allowed in your account</h3>' + (tested.length ? '<div class="sig-grid">' + tested.map(function (x) { return sigCard(x, risk); }).join("") + "</div>" :
      '<div class="empty">None yet. No strategy that the 50K Builder allows (flat by 16:10, within its loss limits) has passed testing, so there are no signals to trade in this account.' + (research.length ? " " + research.length + " strategies passed but hold overnight; they’re shown below for reference." : "") + "</div>");
    if (research.length) html += '<h3 class="tier">Passed, but not allowed in this account <small>they hold overnight</small></h3><div class="sig-grid">' + research.map(function (x) { return sigCard(x, risk); }).join("") + "</div>";
    html += '<h3 class="tier">Candidates <small>provisional · every check holds and significant on its own, but not after allowing for ' + Lb.trials + " tests</small></h3>" + (cand.length ? '<div class="sig-grid">' + cand.map(function (x) { return sigCard(x, risk); }).join("") + "</div>" : '<p class="muted">None.</p>');
    html += '<details class="paper"><summary>Paper positions today (' + paper.length + ") · failed testing, for the record only</summary>" +
      (paper.length ? "<ul>" + paper.map(function (x) { var lv = x.live; return "<li>" + esc(D.markets[x.market].name) + " · " + esc(x.name) + ": <b>" + esc(lv.dir) + "</b>" + (lv.entry ? " from " + fmt(lv.entry, D.markets[x.market]) + ", stop " + fmt(lv.stop, D.markets[x.market]) : "") + "</li>"; }).join("") + "</ul>" : '<p class="muted">None today.</p>') + "</details>" +
      '<p class="fine">Alerts: when a tested or candidate signal changes, the engine opens an issue in the <a href="https://github.com/grobentham/iron-brain/issues?q=label%3Asignal">iron-brain repository</a>, which GitHub sends to its owner by email or the GitHub app. Research only, not advice.</p>';
    $("sig-body").innerHTML = html;
    $("sig-risk").onchange = function () { var x = Number($("sig-risk").value); if (x > 0) { store.set("ib-risk", String(x)); signalsView(); } };
  }
  function sigCard(x, risk) {
    var v = D.markets[x.market], lv = x.live || {}, on = lv.state === "signal";
    var stopPts = on && lv.stop && lv.entry ? Math.abs(lv.entry - lv.stop) : x.avgDailyMove;
    var nf = stopPts ? Math.floor(risk / (stopPts * v.pv)) : 0, nm = stopPts ? Math.floor(risk / (stopPts * v.micro)) : 0;
    var pos = on ? '<span class="sig ' + (lv.dir === "LONG" ? "long" : "short") + '">' + esc(lv.dir) + "</span>" : '<span class="sig">' + esc(lv.dir === "FLAT" ? "FLAT" : "NO SIGNAL") + "</span>";
    var plan = on && lv.entry ? "Entry " + fmt(lv.entry, v) + " at " + esc(lv.at) + " · stop " + fmt(lv.stop, v) + (lv.target ? " · target " + fmt(lv.target, v) : "") + " · out by " + esc(lv.exitBy) : esc(lv.note || "");
    var size = stopPts ? "At $" + Math.round(risk).toLocaleString("en-US") + " risk " + (on && lv.stop ? "to the stop (" + pts(stopPts, v) + " pts)" : "and a stop one average daily move away (" + pts(Math.round(stopPts / v.tick) * v.tick, v) + " pts; the rule itself has no stop)") + (nm ? ": <b>" + nf + "</b> full or <b>" + nm + "</b> micro." : ": too small for one contract. One micro risks " + usd(stopPts * v.micro) + " here.") : "";
    return '<div class="scard ' + x.tier + '"><div class="sc-top"><span class="tierb ' + x.tier + '">' + (x.tier === "tested" ? "TESTED" : x.tier === "research" ? "NOT ALLOWED" : "CANDIDATE") + '</span><b>' + esc(v.name) + " · " + esc(x.name) + "</b>" + pos + "</div>" +
      '<p class="sc-rule">' + esc(x.rule) + "</p><p>" + plan + "</p>" + (lv.next ? "<p><b>Next:</b> " + esc(lv.next) + "</p>" : "") + (size ? '<p class="sc-size">' + size + "</p>" : "") +
      '<p class="fine">Backtest ' + esc(x.from.slice(0, 4)) + "–" + esc(x.to.slice(0, 4)) + ": " + usd(x.perYearUsd) + "/yr per contract, max drawdown " + usd(-x.maxDdUsd) + " · Sharpe " + x.sharpe.toFixed(2) + " · t " + x.t.toFixed(2) + (x.tier === "candidate" ? " (needs " + D.lab.bar.toFixed(2) + ")" : "") + " · beat " + pc(x.beatRandom) + " of random runs · forward record: " + x.forward.trades + " trade" + (x.forward.trades === 1 ? "" : "s") + (x.forward.trades ? ", " + usd(x.forward.usd) : "") + " since " + esc(x.forward.since) + ".</p></div>";
  }

  /* ---- strategy lab ---- */
  var CHECKS = { t: "t past the bar", random: "beats random timing", halves: "profit in both halves", recent: "profit over the last year", sample: "enough trades" };
  var VERDICT = { passed: ["pass", "Passed"], promising: ["mid", "Promising"], inconclusive: ["fail", "Inconclusive"], "no edge": ["fail", "No edge"] };
  var open_ = store.get("ib-lab-open") || "";
  function usd(x) { return x == null ? "—" : (x < 0 ? "−$" : "$") + Math.abs(Math.round(x)).toLocaleString("en-US"); }
  function labView() {
    var Lb = D.lab;
    if (!Lb) { $("lab-body").innerHTML = '<p class="muted">The strategy lab hasn’t run yet.</p>'; return; }
    var all = Lb.strategies, mine = all.filter(function (x) { return x.market === cur; }), v = D.markets[cur];
    var passed = all.filter(function (x) { return x.passed; });
    var head = '<div class="stats">' +
      stat("Registered", esc(Lb.registered), Lb.trials + " tests: " + (Lb.trials / 2) + " rules × 2 markets") +
      stat("Passed", passed.length + " of " + Lb.trials, passed.length ? passed.map(function (x) { return x.name + " (" + D.markets[x.market].name + ")"; }).join(", ") : "nothing has earned a place on the desk") +
      stat("Bar", "t ≥ " + Lb.bar.toFixed(2), "5% split across all " + Lb.trials + " tests, plus four more checks") +
      stat("Costs", v.name + " " + Lb.costs[cur] + " pts", "per round trip, about one tick each side plus commission") + "</div>";
    var rows = mine.map(function (x) {
      var miss = Object.keys(x.checks).filter(function (k) { return !x.checks[k]; });
      var V = VERDICT[x.verdict] || ["fail", x.verdict], res_ = '<span class="' + V[0] + '" title="' + esc(miss.map(function (k) { return "✗ " + CHECKS[k]; }).join("  ")) + '">' + V[1] + "</span>";
      var key = x.market + ":" + x.id, isOpen = key === open_;
      var lv = x.live || {}, today = lv.state === "signal" ? '<span class="sig ' + (!x.passed ? "paper" : lv.dir === "LONG" ? "long" : lv.dir === "SHORT" ? "short" : "") + '" title="' + (x.passed ? "Tested signal" : "Paper only: this strategy failed testing") + '">' + esc(lv.dir) + (x.passed ? "" : " · paper") + "</span>" : '<span class="muted">' + (lv.state === "waiting" ? "waiting" : lv.dir === "FLAT" ? "flat" : "none") + "</span>";
      return '<tr class="srow' + (x.passed ? " ok" : "") + (isOpen ? " open" : "") + '" data-k="' + esc(key) + '"><td><b>' + esc(x.name) + "</b><small>" + (x.kind === "daily" ? "Daily, since " + esc(x.from.slice(0, 4)) : "Intraday, since " + esc(x.from.slice(0, 7))) + '</small></td><td class="n">' + x.trades + '</td><td class="n">' + pc(x.win) + '</td><td class="n ' + (x.perYearUsd >= 0 ? "pos" : "neg") + '">' + usd(x.perYearUsd) + '</td><td class="n">' + usd(-x.maxDdUsd) + '</td><td class="n">' + x.t.toFixed(1) + '</td><td class="n">' + pc(x.beatRandom) + '</td><td class="n">' + x.sharpe.toFixed(2) + " <small>(" + x.sharpeRange[0].toFixed(1) + " to " + x.sharpeRange[1].toFixed(1) + ")</small></td><td>" + res_ + "</td><td>" + acctCell(x) + "</td><td>" + today + "</td></tr>" +
        (isOpen ? '<tr class="sdet"><td colspan="11">' + detail(x, v) + "</td></tr>" : "");
    }).join("");
    $("lab-body").innerHTML = head +
      '<div class="card"><h3>' + esc(v.name) + ' strategies</h3><div class="scroll"><table class="t lab"><thead><tr><th>Strategy</th><th class="n">Trades</th><th class="n">Win</th><th class="n">Per year</th><th class="n">Max DD</th><th class="n">t</th><th class="n">vs random</th><th class="n">Sharpe (95% range)</th><th>Verdict</th><th>50K Builder eval<br><small>at $500 risk</small></th><th>Today</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      '<p class="fine">Dollars are per full contract (one ' + esc(v.name) + " point is $" + v.pv + ") after costs. “vs random” is the share of 200 random-timing runs of the same rule that it beat. Sharpe is annualised, with the range the result is consistent with. <b>Inconclusive</b> means the data can’t rule a worthwhile edge (Sharpe ≥ " + Lb.meaningful + ") in or out; <b>no edge</b> means it can. <b>Promising</b> holds up on every check and is significant on its own, but not after allowing for " + Lb.trials + " tests. Click a row for details.</p></div>" +
      (Lb.changes ? '<details class="paper"><summary>Method changes (' + Lb.changes.length + ")</summary><ul>" + Lb.changes.map(function (c) { return "<li><b>" + esc(c[0]) + "</b> " + esc(c[1]) + "</li>"; }).join("") + "</ul><p class=\"fine\">The rules themselves are never edited. Changes to how they’re tested were made after seeing results, so the forward record, which no change can touch, is the cleaner test.</p></details>" : "");
    Array.prototype.forEach.call($("lab-body").querySelectorAll("tr.srow"), function (tr) {
      tr.onclick = function () { var k = tr.getAttribute("data-k"); open_ = open_ === k ? "" : k; store.set("ib-lab-open", open_); labView(); };
    });
  }
  function detail(x, v) {
    var lv = x.live || {}, checks = Object.keys(x.checks).map(function (k) { return '<li class="' + (x.checks[k] ? "y" : "n") + '">' + esc(CHECKS[k]) + "</li>"; }).join("");
    var live = lv.state === "signal" ? "<b>" + esc(lv.dir) + "</b>" + (lv.entry ? " from " + fmt(lv.entry, v) + " at " + esc(lv.at) + ", stop " + fmt(lv.stop, v) + (lv.target ? ", target " + fmt(lv.target, v) : "") + ", out by " + esc(lv.exitBy) : " · " + esc(lv.note || "")) : esc(lv.note || (lv.dir === "FLAT" ? "Flat." : "No signal."));
    var tr = (x.recentTrades || []).slice().reverse().map(function (t) { return "<tr><td>" + esc(t.date) + "</td><td>" + (t.dir > 0 ? "Long" : "Short") + '</td><td class="n">' + fmt(t.entry, v) + '</td><td class="n">' + fmt(t.exit, v) + "</td><td>" + esc(t.why) + '</td><td class="n ' + (t.net >= 0 ? "pos" : "neg") + '">' + usd(t.net * v.pv) + "</td></tr>"; }).join("");
    return '<div class="det"><div><p class="rule">' + esc(x.rule) + '</p><ul class="checks">' + checks + "</ul>" +
      '<p class="fine">t ' + x.t.toFixed(2) + " (bar " + D.lab.bar.toFixed(2) + ") · this sample can reliably detect a Sharpe of " + x.detectable.toFixed(2) + " · deflated Sharpe " + (x.dsr == null ? "—" : x.dsr.toFixed(2)) + " · beat " + pc(x.beatRandom) + " of random runs · halves " + Math.round(x.halvesBp[0]) + " / " + Math.round(x.halvesBp[1]) + " bp · last year " + Math.round(x.recentBp) + " bp · profit factor " + (x.pf == null ? "—" : x.pf.toFixed(2)) + " · stopped out " + pc(x.stops) + " · 95% Monte Carlo drawdown " + usd(-x.mcDd95Usd) + "</p>" +
      '<p><b>Today' + (x.passed ? "" : " (paper only)") + ":</b> " + live + "</p>" +
      evalTable(x, v) +
      '<p><b>Forward record</b> since ' + esc(x.forward.since) + ": " + x.forward.trades + " trade" + (x.forward.trades === 1 ? "" : "s") + (x.forward.trades ? ", " + usd(x.forward.usd) : "") + ".</p></div>" +
      "<div>" + equity(x.curve) + (tr ? '<table class="t"><thead><tr><th>Date</th><th>Side</th><th class="n">In</th><th class="n">Out</th><th>Exit</th><th class="n">Net</th></tr></thead><tbody>' + tr + "</tbody></table>" : "") + "</div></div>";
  }
  function evalTable(x, v) {
    if (!x.tradable) return '<p><b>50K Builder:</b> not allowed. This rule holds positions overnight, and MyFundedFutures closes every position at 16:10 New York.</p>';
    var rows = (x.account || []).map(function (a) {
      if (a.unsizeable) return "<tr><td>" + usd(a.risk) + '</td><td colspan="4">Too small: one micro at this rule’s stop risks ' + usd(a.microRiskUsd) + "</td></tr>";
      return "<tr><td>" + usd(a.risk) + '</td><td class="n">' + a.micros + '</td><td class="n">' + pc(a.pass) + " <small>(luck " + pc(a.noEdge.pass) + ')</small></td><td class="n">' + pc(a.breach) + '</td><td class="n">' + (a.medianDays || "—") + "</td></tr>";
    }).join("");
    return rows ? '<p><b>50K Builder evaluation</b>, simulated from this rule’s own history (60 trading days, default plan):</p><table class="t"><thead><tr><th>Risk</th><th class="n">Micros</th><th class="n">Pass</th><th class="n">Fail</th><th class="n">Median days</th></tr></thead><tbody>' + rows + '</tbody></table><p class="fine">“Luck” is the pass rate of the same trades with their average profit removed. A rule only helps if it passes clearly more often than luck.</p>' : "";
  }
  function equity(c) {
    if (!c || c.length < 2) return '<p class="muted">Not enough trades for a curve.</p>';
    var W = 420, H = 150, ys = c.map(function (p) { return p[1]; }), lo = Math.min(0, Math.min.apply(null, ys)), hi = Math.max(0, Math.max.apply(null, ys)), sp = hi - lo || 1;
    var X = function (i) { return 4 + (i / (c.length - 1)) * (W - 8); }, Y = function (y) { return 8 + (1 - (y - lo) / sp) * (H - 28); };
    var d = c.map(function (p, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(p[1]).toFixed(1); }).join(" ");
    return '<svg class="eq" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Equity curve"><line x1="4" x2="' + (W - 4) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '"/><path d="' + d + '" class="' + (ys[ys.length - 1] >= 0 ? "up" : "dn") + '"/><text x="4" y="' + (H - 4) + '">' + esc(c[0][0].slice(0, 7)) + '</text><text x="' + (W - 4) + '" y="' + (H - 4) + '" text-anchor="end">' + esc(c[c.length - 1][0].slice(0, 7)) + " · " + usd(ys[ys.length - 1]) + "</text></svg>";
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
    tabs(); acctView(); signalsView(); desk(true); labView(); testsView(); ctx();
    fetch("/displace/data/bias/current.json?t=" + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).then(function (b) { B = b; ctx(); }).catch(function () { ctx(); });
    setInterval(function () { desk(false); }, 15000);
    setInterval(function () { load().then(function () { desk(false); signalsView(); }); }, 300000);
  }).catch(function () { $("desk-body").innerHTML = '<p class="muted">The desk data isn’t available yet.</p>'; });
  window.IB = { state: state, pTouch: pTouch, surv: surv };
})();
