/*
 * Quiz Autopilot content script.
 *
 * Reads the question and answer choices on the page, looks the question up in
 * the answer keys you imported, highlights the correct choice and (optionally)
 * clicks it. Blooket and Kahoot have dedicated selectors; on any other page
 * the question and answers are found by their text.
 */
(function () {
  'use strict';

  if (window.__quizAutopilotRunning) return;
  window.__quizAutopilotRunning = true;

  const T = self.QAText;
  const M = self.QAMatcher;
  const S = self.QAStorage;

  const HOST_ID = 'quiz-autopilot-host';
  const TAKEOVER_EVENT = 'quiz-autopilot:takeover';
  const SCAN_GAP_MS = 150; // at most one scan per this interval while the page changes
  const TICK_MS = 1000; // re-check now and then for changes that don't touch the DOM
  const RECLICK_GUARD_MS = 3000; // never answer the same question twice within this window
  const KAHOOT_SHAPES = ['red triangle', 'blue diamond', 'yellow circle', 'green square'];

  const SITES = [
    {
      id: 'blooket',
      name: 'Blooket',
      host: /(^|\.)blooket\.com$/i,
      question: ['[class*="questionText"]'],
      option: ['[class*="answerContainer"]'],
      optionText: ['[class*="answerText"]'],
    },
    {
      id: 'kahoot',
      name: 'Kahoot',
      host: /(^|\.)kahoot\.it$/i,
      question: [
        '[data-functional-selector="block-title"]',
        '[data-functional-selector="question-title"]',
        '[data-functional-selector*="question-title"]',
        '[data-functional-selector*="block-title"]',
      ],
      option: ['[data-functional-selector^="answer-"]'],
      optionFilter: (el) => /^answer-\d+$/.test(el.getAttribute('data-functional-selector') || ''),
      optionKey: (el) => parseInt((el.getAttribute('data-functional-selector') || '').slice(7), 10),
      optionText: ['[data-functional-selector^="question-choice-text"]'],
      // Shape names announced to screen readers are not answer text.
      ignoreOptionText: /^(?:\s|triangle|diamond|circle|square|[▲◆●■])*$/i,
      optionLabel: (key) => KAHOOT_SHAPES[key] || `answer ${key + 1}`,
      counter: ['[data-functional-selector="question-index-counter"]'],
      submit: ['[data-functional-selector="multi-select-submit-button"]'],
    },
  ];
  const GENERIC = { id: 'generic', name: 'this page', host: /.^/, question: [], option: [], optionText: [] };
  const site = SITES.find((s) => s.host.test(location.hostname)) || GENERIC;

  let settings = S.withDefaults();
  let index = new M.KeyIndex([]);
  let loaded = false;
  let stopped = false;
  let current = null; // the question on screen: { sig, timer, clicked }
  let lastClick = null; // { sig, at }
  let lastSetId = null; // answer key that matched most recently
  let lastAction = '';
  let scanTimer = 0;
  let lastScanAt = 0;
  let tickTimer = 0;

  // ------------------------------------------------------------ DOM helpers

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (
      typeof el.checkVisibility === 'function' &&
      !el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })
    ) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function textOf(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function queryVisible(selectors, root) {
    const out = [];
    for (const selector of selectors) {
      let found;
      try {
        found = (root || document).querySelectorAll(selector);
      } catch (err) {
        continue;
      }
      for (const el of found) if (!out.includes(el) && isVisible(el)) out.push(el);
    }
    return out;
  }

  function innermost(els) {
    return els.filter((el) => !els.some((other) => other !== el && el.contains(other)));
  }

  const CLICKABLE =
    'button, a[href], label, summary, select, input:not([type="hidden"]), [role="button"], [role="radio"], ' +
    '[role="option"], [role="checkbox"], [role="menuitem"], [role="tab"], [onclick], [tabindex]:not([tabindex="-1"])';

  /** Nearest element (itself or an ancestor) that looks like it reacts to clicks. */
  function clickableOf(el, cache) {
    const chain = [];
    let found = null;
    for (let cur = el, depth = 0; cur && cur !== document.body && depth < 6; cur = cur.parentElement, depth++) {
      if (cache && cache.has(cur)) {
        found = cache.get(cur);
        break;
      }
      chain.push(cur);
      if (cur.matches(CLICKABLE) || getComputedStyle(cur).cursor === 'pointer') {
        found = cur;
        break;
      }
    }
    if (cache) for (const c of chain) cache.set(c, found);
    return found;
  }

  function isDisabled(el) {
    return !!(el.disabled || el.closest('[disabled], [aria-disabled="true"]'));
  }

  /** Outer element to outline for an answer found by its text. */
  function cardOf(el) {
    let card = clickableOf(el) || el;
    if (card.matches(CLICKABLE)) return card;
    // `cursor: pointer` is inherited: climb to the outermost pointer element that shows the same text.
    const text = textOf(card);
    for (let up = card.parentElement; up && up !== document.body; up = up.parentElement) {
      if (getComputedStyle(up).cursor !== 'pointer' || textOf(up) !== text) break;
      card = up;
    }
    return card;
  }

  /** Clicks the middle of `el` the way a mouse would: on the deepest element under that point. */
  function clickElement(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const target = hit && el.contains(hit) ? hit : el;
    const mouse = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    const pointer = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, mouse);
    const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    target.dispatchEvent(new Pointer('pointerover', pointer));
    target.dispatchEvent(new MouseEvent('mouseover', mouse));
    target.dispatchEvent(new Pointer('pointerdown', Object.assign({}, pointer, { buttons: 1 })));
    target.dispatchEvent(new MouseEvent('mousedown', Object.assign({}, mouse, { buttons: 1 })));
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    target.dispatchEvent(new Pointer('pointerup', pointer));
    target.dispatchEvent(new MouseEvent('mouseup', mouse));
    target.dispatchEvent(new MouseEvent('click', Object.assign({}, mouse, { detail: 1 })));
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ------------------------------------------------------------ reading the page

  function readOptions() {
    if (!site.option.length) return [];
    let els = queryVisible(site.option);
    if (site.optionFilter) els = els.filter(site.optionFilter);
    return innermost(els).map((el) => {
      const inner = site.optionText.length ? queryVisible(site.optionText, el)[0] : null;
      let text = textOf(inner || el);
      if (site.ignoreOptionText && site.ignoreOptionText.test(text)) text = '';
      return { el, text, key: site.optionKey ? site.optionKey(el) : null };
    });
  }

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION']);

  /** Every visible piece of text on the page, mapped to the deepest element showing it. */
  function collectBlocks(optionEls) {
    const body = document.body;
    if (!body) return [];
    const byText = new Map();
    const seen = new Set();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node;
    let count = 0;
    while ((node = walker.nextNode()) && count++ < 5000) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      let el = node.parentElement;
      for (let depth = 0; el && el !== body && depth < 4; depth++, el = el.parentElement) {
        if (seen.has(el)) break;
        seen.add(el);
        if (SKIP_TAGS.has(el.tagName) || el instanceof SVGElement) break;
        if ((el.textContent || '').length > 600) break; // big containers are not one question or answer
        if (!isVisible(el)) continue;
        const text = textOf(el);
        if (text && text.length <= 600 && !byText.has(text)) byText.set(text, el);
      }
    }
    const clickCache = new Map();
    const blocks = [];
    for (const [text, el] of byText) {
      blocks.push({
        text,
        el,
        inOption: optionEls.some((o) => o.contains(el) || el.contains(o)),
        clickable: !!clickableOf(el, clickCache),
        weight: parseFloat(getComputedStyle(el).fontSize) || 0,
      });
    }
    return blocks;
  }

  function readView() {
    const options = readOptions();
    const blocks = collectBlocks(options.map((o) => o.el));
    let questionNumber = null;
    if (site.counter) {
      const counter = queryVisible(site.counter)[0];
      const match = counter && textOf(counter).match(/\d+/);
      if (match) questionNumber = Number(match[0]);
    }
    return {
      options,
      blocks,
      data: {
        questions: queryVisible(site.question).map(textOf).filter(Boolean),
        options: options.map((o) => o.text),
        optionKeys: options.map((o) => o.key),
        blocks: blocks.map((b) => ({ text: b.text, weight: b.weight, inOption: b.inOption, clickable: b.clickable })),
        questionNumber,
        preferredSetId: lastSetId,
      },
    };
  }

  function resolveTargets(result, view) {
    const out = [];
    for (const i of result.optionTargets || []) {
      const o = view.options[i];
      if (o) out.push({ el: o.el, label: o.text || (site.optionLabel ? site.optionLabel(o.key) : 'answer') });
    }
    for (const i of result.blockTargets || []) {
      const b = view.blocks[i];
      if (b) out.push({ el: cardOf(b.el), label: b.text });
    }
    return out;
  }

  function signature(result, targets) {
    return [result.entry.id, T.strict(result.questionText), targets.map((t) => T.strict(t.label)).join('|')].join('\n');
  }

  function solveNow() {
    const view = readView();
    const result = M.solve(index, view.data, settings);
    const targets = result.ok ? resolveTargets(result, view) : [];
    return { result, targets, sig: targets.length ? signature(result, targets) : '' };
  }

  // ------------------------------------------------------------ acting

  function scan() {
    if (stopped) return;
    if (!extensionAlive()) {
      stop();
      return;
    }
    if (!loaded) return;
    ui.ensure();
    if (!settings.enabled) {
      forget();
      ui.status('muted', 'Paused.', 'Press Alt+Shift+A or use the extension menu to resume.');
      return;
    }
    if (!index.size) {
      forget();
      ui.status('warn', 'No answer keys yet.', 'Click the Quiz Autopilot icon to import your answer key.');
      return;
    }

    const { result, targets, sig } = solveNow();
    if (!targets.length) {
      forget();
      const [tone, message] = explain(result);
      ui.status(tone, message, lastAction);
      return;
    }
    if (result.how !== 'number') lastSetId = result.entry.setId;
    ui.highlight(targets.map((t) => t.el));
    if (current && current.sig === sig) return;

    cancelPending();
    const answer = targets.map((t) => t.label).join(' + ');
    current = { sig, timer: 0, clicked: false };
    if (lastClick && lastClick.sig === sig && Date.now() - lastClick.at < RECLICK_GUARD_MS) {
      current.clicked = true; // the same question re-rendered right after we answered it
      return;
    }
    if (!settings.autoClick) {
      ui.status('ok', `Answer: ${answer}`, describe(result));
      return;
    }
    ui.status('ok', `Answering: ${answer}`, describe(result));
    current.timer = setTimeout(() => answerNow(sig, 0), Math.max(0, Number(settings.delayMs) || 0));
  }

  async function answerNow(sig, attempt) {
    if (stopped || !current || current.sig !== sig || current.clicked) return;
    current.timer = 0;
    if (!settings.enabled || !settings.autoClick) return;
    const { result, targets, sig: now } = solveNow();
    if (now !== sig) {
      // The screen changed (or is mid-render): let the next scan decide again from scratch.
      current = null;
      queueScan();
      return;
    }
    if (targets.some((t) => isDisabled(t.el))) {
      // Buttons are often disabled for a moment while the question animates in.
      if (attempt < 40) current.timer = setTimeout(() => answerNow(sig, attempt + 1), 250);
      else ui.status('warn', 'The answer button stayed disabled, so it wasn’t clicked.', describe(result));
      return;
    }
    current.clicked = true;
    lastClick = { sig, at: Date.now() };
    const submit = site.submit ? queryVisible(site.submit)[0] : null;
    const picks = submit ? targets : targets.slice(0, 1); // multi-select questions need every answer
    for (let i = 0; i < picks.length; i++) {
      if (i) await sleep(150);
      clickElement(picks[i].el);
    }
    if (submit) {
      await sleep(300);
      const button = queryVisible(site.submit)[0];
      if (button && !isDisabled(button)) clickElement(button);
    }
    const answer = picks.map((t) => t.label).join(' + ');
    lastAction = `Last answer: ${answer}`;
    ui.status('ok', `Clicked: ${answer}`, describe(result));
  }

  function cancelPending() {
    if (current && current.timer) clearTimeout(current.timer);
    if (current) current.timer = 0;
  }

  function forget() {
    cancelPending();
    current = null;
    ui.highlight([]);
  }

  function short(text, max) {
    const s = String(text || '');
    return s.length > (max || 60) ? s.slice(0, (max || 60) - 1) + '…' : s;
  }

  function explain(result) {
    switch (result.reason) {
      case 'answer-not-found':
        return ['warn', `Found “${short(result.entry.q)}” - waiting for a choice that matches “${short(result.entry.correct.join(' / '), 40)}”.`];
      case 'ambiguous':
        return ['warn', 'This question matches entries with different answers in your keys, so it was skipped.'];
      case 'no-text':
        return site.id === 'kahoot'
          ? ['warn', 'Kahoot isn’t showing the question on this device. Turn on “Show questions and answers on players’ devices”, or enable only this game’s answer key.']
          : ['warn', 'The answer buttons have no text to match.'];
      case 'no-number-match':
        return ['warn', `Question ${result.number} isn’t in the answer key.`];
      default:
        return ['muted', 'Watching for a question from your answer keys…'];
    }
  }

  function describe(result) {
    const how = {
      exact: 'exact match',
      fuzzy: `close match (${Math.round(result.score * 100)}%)`,
      options: 'matched by its answer choices',
      number: `matched by question number ${result.entry.n}`,
    }[result.how];
    return `${how} · ${result.entry.setName}`;
  }

  function queueScan() {
    if (stopped || scanTimer) return;
    const wait = Math.max(0, SCAN_GAP_MS - (Date.now() - lastScanAt));
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      lastScanAt = Date.now();
      try {
        scan();
      } catch (err) {
        console.warn('[Quiz Autopilot]', err);
      }
    }, wait);
  }

  // ------------------------------------------------------------ on-page UI

  const ui = (() => {
    const CSS = `
      :host { all: initial; }
      .panel {
        position: fixed; left: 12px; bottom: 12px; max-width: min(340px, calc(100vw - 24px));
        pointer-events: auto; box-sizing: border-box; padding: 8px 10px; border-radius: 12px;
        font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        color: #f9fafb; background: rgba(17, 24, 39, 0.92); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
      }
      .panel[hidden] { display: none; }
      .head { display: flex; align-items: center; gap: 8px; }
      .title { font-weight: 700; }
      .spacer { flex: 1; }
      .chip { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; padding: 2px 6px; border-radius: 999px; color: #fff; background: #16a34a; }
      .chip.highlight { background: #d97706; }
      .chip.paused { background: #6b7280; }
      button {
        all: unset; cursor: pointer; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px;
        color: #f9fafb; background: rgba(255, 255, 255, 0.12);
      }
      button:hover { background: rgba(255, 255, 255, 0.22); }
      button:focus-visible { outline: 2px solid #93c5fd; }
      .msg { margin-top: 6px; overflow-wrap: anywhere; }
      .msg.ok { color: #86efac; }
      .msg.warn { color: #fcd34d; }
      .msg.muted { color: #d1d5db; }
      .detail { margin-top: 2px; font-size: 11px; color: #9ca3af; overflow-wrap: anywhere; }
      .detail:empty { display: none; }
      .box {
        position: fixed; display: none; box-sizing: border-box; pointer-events: none; border-radius: 12px;
        border: 4px solid #22c55e; box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.35), 0 0 22px rgba(34, 197, 94, 0.75);
      }
      .box span {
        position: absolute; top: -13px; right: -13px; width: 24px; height: 24px; border-radius: 50%;
        background: #22c55e; color: #fff; text-align: center; font: 700 15px/24px system-ui, sans-serif;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
      }
    `;
    let host = null;
    let parts = null;
    let targets = [];
    let boxes = [];
    let frame = 0;

    function ensure() {
      if (host && host.isConnected) return;
      const stale = document.getElementById(HOST_ID);
      if (stale) stale.remove();
      host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style>
        <div class="panel" hidden>
          <div class="head">
            <span class="chip"></span><span class="title">Quiz Autopilot</span><span class="spacer"></span>
            <button type="button" class="toggle" title="Pause or resume (Alt+Shift+A)"></button>
            <button type="button" class="close" title="Hide this panel (turn it back on in the extension menu)">✕</button>
          </div>
          <div class="msg"></div>
          <div class="detail"></div>
        </div>
        <div class="boxes"></div>`;
      parts = {
        panel: root.querySelector('.panel'),
        chip: root.querySelector('.chip'),
        toggle: root.querySelector('.toggle'),
        close: root.querySelector('.close'),
        msg: root.querySelector('.msg'),
        detail: root.querySelector('.detail'),
        boxes: root.querySelector('.boxes'),
      };
      boxes = [];
      // Keep clicks on the panel away from the game (e.g. "click anywhere to continue").
      for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'keydown']) {
        parts.panel.addEventListener(type, (e) => e.stopPropagation());
      }
      parts.toggle.addEventListener('click', () => S.saveSettings({ enabled: !settings.enabled }).catch(() => {}));
      parts.close.addEventListener('click', () => S.saveSettings({ showPanel: false }).catch(() => {}));
      document.documentElement.appendChild(host);
      refreshChrome();
    }

    function refreshChrome() {
      if (!parts) return;
      parts.panel.hidden = !settings.showPanel;
      const mode = !settings.enabled ? 'paused' : settings.autoClick ? 'auto' : 'highlight';
      parts.chip.className = `chip ${mode}`;
      parts.chip.textContent = { paused: 'PAUSED', auto: 'AUTO', highlight: 'HIGHLIGHT' }[mode];
      parts.toggle.textContent = settings.enabled ? 'Pause' : 'Resume';
    }

    function status(tone, message, detail) {
      if (!parts) return;
      refreshChrome();
      parts.msg.className = `msg ${tone}`;
      parts.msg.textContent = message;
      parts.detail.textContent = detail || '';
    }

    function highlight(els) {
      targets = els.slice();
      if (!parts) return;
      while (boxes.length < targets.length) {
        const box = document.createElement('div');
        box.className = 'box';
        box.innerHTML = '<span>✓</span>';
        parts.boxes.appendChild(box);
        boxes.push(box);
      }
      if (frame) cancelAnimationFrame(frame);
      position();
    }

    function position() {
      frame = 0;
      boxes.forEach((box, i) => {
        const el = targets[i];
        const r = el && el.isConnected ? el.getBoundingClientRect() : null;
        if (!r || !r.width || !r.height) {
          box.style.display = 'none';
          return;
        }
        box.style.display = 'block';
        box.style.left = `${r.left - 6}px`;
        box.style.top = `${r.top - 6}px`;
        box.style.width = `${r.width + 12}px`;
        box.style.height = `${r.height + 12}px`;
      });
      // Follow the answer while it animates or the page scrolls.
      if (targets.length) frame = requestAnimationFrame(position);
    }

    function destroy() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      targets = [];
      if (host) host.remove();
      host = null;
      parts = null;
    }

    return { ensure, status, highlight, refreshChrome, destroy };
  })();

  // ------------------------------------------------------------ lifecycle

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (err) {
      return false;
    }
  }

  function onStorageChange(changes, area) {
    if (area !== 'local') return;
    if (changes.settings) settings = S.withDefaults(changes.settings.newValue);
    if (changes.sets) index = new M.KeyIndex(changes.sets.newValue || []);
    if (!changes.settings && !changes.sets) return;
    // Re-evaluate the question on screen with the new settings, unless it was already answered.
    if (current && !current.clicked) {
      cancelPending();
      current = null;
    }
    ui.refreshChrome();
    queueScan();
  }

  function onKeyDown(e) {
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyA') {
      e.preventDefault();
      e.stopPropagation();
      S.saveSettings({ enabled: !settings.enabled }).catch(() => {});
    }
  }

  const observer = new MutationObserver(queueScan);

  function start() {
    // Copies injected by an older version of the extension live in another JS world; stop them.
    document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
    document.addEventListener(TAKEOVER_EVENT, stop);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'disabled', 'aria-hidden'],
    });
    tickTimer = setInterval(() => {
      if (!document.hidden) queueScan();
    }, TICK_MS);
    window.addEventListener('keydown', onKeyDown, true);
    chrome.storage.onChanged.addListener(onStorageChange);
    chrome.storage.local.get(['settings', 'sets']).then(
      (data) => {
        settings = S.withDefaults(data.settings);
        index = new M.KeyIndex(data.sets || []);
        loaded = true;
        queueScan();
      },
      (err) => console.warn('[Quiz Autopilot]', err)
    );
    queueScan();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    clearInterval(tickTimer);
    clearTimeout(scanTimer);
    cancelPending();
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener(TAKEOVER_EVENT, stop);
    try {
      chrome.storage.onChanged.removeListener(onStorageChange);
    } catch (err) {
      // The extension was reloaded or removed; nothing left to unsubscribe from.
    }
    ui.destroy();
    window.__quizAutopilotRunning = false;
  }

  start();
})();
