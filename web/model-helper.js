(() => {
  'use strict';

  const EXPECTED = {
    expectedInputs: [
      { type: 'text', languages: ['en'] },
      { type: 'image' }
    ],
    expectedOutputs: [{ type: 'text', languages: ['en'] }]
  };

  const state = {
    ready: false,
    preparing: false,
    controller: null,
    timer: null,
    startedAt: 0,
    lastProgressAt: 0,
    pct: 0
  };

  const $ = id => document.getElementById(id);
  const ui = {};

  function elapsed() {
    if (!state.startedAt) return '0:00';
    const sec = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  function setMessage(text, tone = '') {
    if (!ui.message) return;
    ui.message.textContent = text;
    ui.message.dataset.tone = tone;
  }

  function setProgress(pct) {
    state.pct = Math.max(0, Math.min(100, Number(pct) || 0));
    if (ui.bar) ui.bar.style.width = `${state.pct}%`;
    if (ui.percent) ui.percent.textContent = `${Math.round(state.pct)}%`;
  }

  function hasScreenshots() {
    const label = $('countLabel')?.textContent || '0';
    const n = Number.parseInt(label, 10);
    return Number.isFinite(n) && n > 0;
  }

  function gateAnalyzeButton() {
    const button = $('analyzeButton');
    if (!button) return;
    if (!state.ready) {
      button.disabled = true;
      button.title = 'Prepare the local Chrome AI model first.';
    } else {
      button.title = '';
      if (hasScreenshots()) button.disabled = false;
    }
  }

  function renderAvailability(availability) {
    const prepare = ui.prepare;
    const cancel = ui.cancel;
    if (!prepare || !cancel) return;

    if (availability === 'available') {
      state.ready = true;
      state.preparing = false;
      prepare.hidden = true;
      cancel.hidden = true;
      setProgress(100);
      setMessage('Local AI is ready. You only need to do this once unless Chrome removes or updates the model.', 'ok');
      gateAnalyzeButton();
      return;
    }

    state.ready = false;
    gateAnalyzeButton();
    if (availability === 'downloadable') {
      prepare.hidden = false;
      prepare.disabled = false;
      prepare.textContent = 'Prepare local AI';
      cancel.hidden = true;
      setMessage('One-time Chrome model download required. Press Prepare local AI to start it directly from your click.', '');
    } else if (availability === 'downloading') {
      prepare.hidden = false;
      prepare.disabled = false;
      prepare.textContent = 'Resume / check download';
      cancel.hidden = true;
      setMessage('Chrome reports that the local model is already downloading. Press Resume / check download to attach live progress.', '');
    } else {
      prepare.hidden = true;
      cancel.hidden = true;
      setMessage('This browser/device cannot use Chrome’s local foundation model. Desktop Chrome and supported hardware are required.', 'bad');
    }
  }

  async function checkAvailability() {
    if (!('LanguageModel' in globalThis)) {
      renderAvailability('unavailable');
      return 'unavailable';
    }
    try {
      const availability = await LanguageModel.availability(EXPECTED);
      renderAvailability(availability);
      return availability;
    } catch (error) {
      console.error('ICT Brain model availability check failed', error);
      renderAvailability('unavailable');
      return 'unavailable';
    }
  }

  async function prepareModel() {
    if (state.preparing || !('LanguageModel' in globalThis)) return;

    state.preparing = true;
    state.ready = false;
    state.startedAt = Date.now();
    state.lastProgressAt = Date.now();
    state.pct = 0;
    setProgress(0);
    gateAnalyzeButton();

    ui.prepare.disabled = true;
    ui.prepare.textContent = 'Preparing…';
    ui.cancel.hidden = false;
    setMessage('Starting Chrome’s one-time local model download…');

    const controller = new AbortController();
    state.controller = controller;

    state.timer = setInterval(() => {
      if (!state.preparing) return;
      const silentFor = Math.floor((Date.now() - state.lastProgressAt) / 1000);
      if (state.pct === 0 && silentFor >= 45) {
        setMessage(`Still waiting for Chrome to begin the download · ${elapsed()}. If this stays at 0%, check chrome://on-device-internals, free disk space and that the connection is unmetered.`, 'warn');
      } else {
        setMessage(`Preparing local AI · ${Math.round(state.pct)}% · ${elapsed()} elapsed`);
      }
    }, 1000);

    try {
      const session = await LanguageModel.create({
        ...EXPECTED,
        signal: controller.signal,
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', event => {
            state.lastProgressAt = Date.now();
            setProgress((Number(event.loaded) || 0) * 100);
            setMessage(`Downloading Chrome local AI · ${Math.round(state.pct)}% · ${elapsed()} elapsed`);
          });
        }
      });

      try { session?.destroy?.(); } catch {}
      state.ready = true;
      setProgress(100);
      setMessage('Local AI ready. Chart analysis is unlocked.', 'ok');
      ui.prepare.hidden = true;
      ui.cancel.hidden = true;

      const status = $('aiStatus');
      if (status) {
        status.textContent = 'On-device AI ready';
        status.className = 'pill ok';
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        setMessage('Model preparation cancelled. You can resume whenever you want.', 'warn');
      } else {
        console.error('ICT Brain model preparation failed', error);
        setMessage(`Chrome could not prepare the local model: ${error?.message || error?.name || 'unknown error'}. Check chrome://on-device-internals and retry.`, 'bad');
      }
      ui.prepare.hidden = false;
      ui.prepare.disabled = false;
      ui.prepare.textContent = 'Retry local AI';
      ui.cancel.hidden = true;
      state.ready = false;
    } finally {
      state.preparing = false;
      state.controller = null;
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
      gateAnalyzeButton();
      if (!state.ready) setTimeout(checkAvailability, 1500);
    }
  }

  function cancelPreparation() {
    state.controller?.abort();
  }

  function init() {
    ui.prepare = $('prepareModelButton');
    ui.cancel = $('cancelModelButton');
    ui.message = $('modelMessage');
    ui.bar = $('modelProgressBar');
    ui.percent = $('modelPercent');
    if (!ui.prepare || !ui.cancel || !ui.message || !ui.bar || !ui.percent) return;

    ui.prepare.addEventListener('click', prepareModel);
    ui.cancel.addEventListener('click', cancelPreparation);

    // The analyzer's internal code may re-enable its button after screenshots change.
    // Keep it gated until the Chrome model is genuinely ready.
    const analyze = $('analyzeButton');
    if (analyze) {
      new MutationObserver(gateAnalyzeButton).observe(analyze, { attributes: true, attributeFilter: ['disabled'] });
    }
    new MutationObserver(gateAnalyzeButton).observe($('countLabel'), { childList: true, characterData: true, subtree: true });

    checkAvailability();
    setInterval(async () => {
      if (!state.preparing && !state.ready) await checkAvailability();
    }, 10000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
