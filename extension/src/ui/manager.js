/*
 * Popup and options page: settings, answer-key import and per-site access.
 * The same page is used for both; in the popup the file picker is replaced by
 * a link to the full page because Chrome closes popups when a file dialog opens.
 */
(async function () {
  'use strict';

  const P = self.QAParser;
  const S = self.QAStorage;
  const $ = (id) => document.getElementById(id);
  const BUILT_IN = /(^|[^a-z0-9-])(blooket\.com|kahoot\.it)\//i;
  const BUILT_IN_HOST = /(^|\.)(blooket\.com|kahoot\.it)$/i;

  const isPopup = !(await chrome.tabs.getCurrent());
  document.body.classList.add(isPopup ? 'is-popup' : 'is-page');

  let { settings, sets } = await S.load();
  let fileName = '';

  // ---------------------------------------------------------------- settings

  const TOGGLES = ['enabled', 'autoClick', 'fuzzy', 'showPanel'];

  function renderSettings() {
    for (const id of TOGGLES) $(id).checked = !!settings[id];
    if (document.activeElement !== $('delayMs')) $('delayMs').value = settings.delayMs;
    document.body.classList.toggle('off', !settings.enabled);
  }

  for (const id of TOGGLES) {
    $(id).addEventListener('change', async (e) => {
      settings = await S.saveSettings({ [id]: e.target.checked });
      renderSettings();
    });
  }

  $('delayMs').addEventListener('change', async (e) => {
    const value = Math.min(10000, Math.max(0, Math.round(Number(e.target.value) || 0)));
    e.target.value = value;
    settings = await S.saveSettings({ delayMs: value });
    renderSettings();
  });

  // ------------------------------------------------------------ answer keys

  function renderSets() {
    const list = $('sets');
    list.textContent = '';
    $('noSets').hidden = sets.length > 0;
    const active = sets.filter((s) => s.enabled !== false).reduce((n, s) => n + s.entries.length, 0);
    $('totals').textContent = sets.length ? `· ${active} question${active === 1 ? '' : 's'} active` : '';

    for (const set of sets) {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = set.enabled !== false;
      toggle.title = 'Use this answer key';
      toggle.addEventListener('change', async () => {
        set.enabled = toggle.checked;
        await S.saveSets(sets);
        renderSets();
      });
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = set.name;
      name.title = set.name;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${set.entries.length} Q`;
      label.append(toggle, name, count);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = 'Delete';
      let disarm = 0;
      del.addEventListener('click', async () => {
        if (!del.classList.contains('armed')) {
          del.classList.add('armed');
          del.textContent = 'Really?';
          disarm = setTimeout(() => {
            del.classList.remove('armed');
            del.textContent = 'Delete';
          }, 3000);
          return;
        }
        clearTimeout(disarm);
        sets = sets.filter((s) => s.id !== set.id);
        await S.saveSets(sets);
        renderSets();
      });

      li.append(label, del);
      list.append(li);
    }
  }

  // ----------------------------------------------------------------- import

  function showMessage(text, tone) {
    const el = $('importMsg');
    el.textContent = text;
    el.className = `msg ${tone || ''}`;
  }

  let previewTimer = 0;
  function preview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const text = $('importText').value;
      const el = $('preview');
      if (!text.trim()) {
        el.textContent = '';
        return;
      }
      try {
        const { entries, format } = P.parseAnswerKey(text);
        el.textContent = `Looks like ${format}: ${entries.length} question${entries.length === 1 ? '' : 's'} found.`;
      } catch (err) {
        el.textContent = err.message;
      }
    }, 200);
  }

  async function importKey() {
    let result;
    try {
      result = P.parseAnswerKey($('importText').value);
    } catch (err) {
      showMessage(err.message, 'error');
      return;
    }
    const name = $('setName').value.trim() || fileName || `Answer key ${sets.length + 1}`;
    const set = { id: crypto.randomUUID(), name, enabled: true, createdAt: Date.now(), entries: result.entries };
    const next = sets.concat(set);
    try {
      await S.saveSets(next);
    } catch (err) {
      showMessage(`Couldn’t save: ${err.message}`, 'error');
      return;
    }
    sets = next;
    $('importText').value = '';
    $('setName').value = '';
    $('preview').textContent = '';
    fileName = '';
    const count = result.entries.length;
    showMessage([`Imported “${name}”: ${count} question${count === 1 ? '' : 's'}.`].concat(result.warnings).join(' '), 'ok');
    renderSets();
  }

  async function loadFile(file) {
    if (/\.(xlsx?|ods|numbers)$/i.test(file.name)) {
      showMessage('Spreadsheet files can’t be read directly. Save the sheet as CSV (File → Download → CSV), or copy the cells and paste them here.', 'error');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showMessage('That file is too large for an answer key.', 'error');
      return;
    }
    $('importText').value = await file.text();
    fileName = file.name.replace(/\.[^.]+$/, '');
    if (!$('setName').value.trim()) $('setName').value = fileName;
    showMessage('');
    preview();
  }

  $('importText').addEventListener('input', preview);
  $('importBtn').addEventListener('click', importKey);
  $('openPage').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await loadFile(file);
    e.target.value = '';
  });

  const dropZone = $('importText');
  dropZone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dropZone.classList.add('drop');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drop'));
  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    dropZone.classList.remove('drop');
    if (!file) return;
    e.preventDefault();
    loadFile(file);
  });

  // ------------------------------------------------------------------ sites

  function prettyPattern(pattern) {
    if (pattern === '<all_urls>') return 'All sites';
    if (pattern.startsWith('file:')) return 'Local files';
    return pattern.replace(/^\*?:?\/\//, '').replace(/^[a-z]+:\/\//, '').replace(/\/\*$/, '');
  }

  function note(text) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = text;
    return p;
  }

  async function renderSites() {
    const { origins = [] } = await chrome.permissions.getAll();
    const custom = origins.filter((o) => !BUILT_IN.test(o));
    const list = $('sites');
    list.textContent = '';
    for (const origin of custom) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = prettyPattern(origin);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'del';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        await chrome.permissions.remove({ origins: [origin] }).catch(() => false);
        renderSites();
      });
      li.append(name, remove);
      list.append(li);
    }
    if (isPopup) await renderSiteAction();
  }

  async function renderSiteAction() {
    const box = $('siteAction');
    box.textContent = '';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let url = null;
    try {
      url = new URL(tab && tab.url);
    } catch (err) {
      url = null;
    }
    if (!url || !/^(https?|file):$/.test(url.protocol)) {
      box.append(note('Open your quiz page in this tab to enable Quiz Autopilot there.'));
      return;
    }
    if (BUILT_IN_HOST.test(url.hostname)) {
      box.append(note(`✓ ${url.hostname} is supported automatically.`));
      return;
    }
    const isFile = url.protocol === 'file:';
    const pattern = isFile ? 'file:///*' : `${url.protocol}//${url.hostname}/*`;
    const label = isFile ? 'local files' : url.hostname;
    if (await chrome.permissions.contains({ origins: [pattern] })) {
      const fileAccess = !isFile || (await chrome.extension.isAllowedFileSchemeAccess());
      box.append(
        note(
          fileAccess
            ? `✓ Enabled on ${label}.`
            : '✓ Enabled for local files - also turn on “Allow access to file URLs” for Quiz Autopilot in chrome://extensions.'
        )
      );
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button primary';
    button.textContent = `Enable on ${label}`;
    button.addEventListener('click', async () => {
      // The background worker registers the script and injects it into this tab once access is granted.
      const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
      if (granted) renderSites();
    });
    box.append(button);
  }

  // --------------------------------------------------------------- startup

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = S.withDefaults(changes.settings.newValue);
      renderSettings();
    }
    if (changes.sets) {
      sets = Array.isArray(changes.sets.newValue) ? changes.sets.newValue : [];
      renderSets();
    }
  });
  chrome.permissions.onAdded.addListener(renderSites);
  chrome.permissions.onRemoved.addListener(renderSites);

  renderSettings();
  renderSets();
  renderSites();
})();
