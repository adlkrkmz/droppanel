/**
 * DropPanel — popup logic
 * Pool tab: CAPTURE -> POST /admin/product/extract
 * Direct List tab: CAPTURE -> POST /admin/product/extract -> POST /admin/listing/run (count=1)
 */
(function () {
  'use strict';

  const API_BASE = 'http://localhost:4000';

  const tabPool = document.getElementById('tabPool');
  const tabDirect = document.getElementById('tabDirect');
  const poolTabContent = document.getElementById('poolTabContent');
  const directTabContent = document.getElementById('directTabContent');

  const storeSelect = document.getElementById('storeSelect');
  const directStoreSelect = document.getElementById('directStoreSelect');

  const directQuantityInput = document.getElementById('directQuantityInput');

  const btnCapturePool = document.getElementById('btnCapturePool');
  const btnCaptureDirect = document.getElementById('btnCaptureDirect');

  const messageEl = document.getElementById('message');

  function setMessage(text, type) {
    messageEl.textContent = text || '';
    messageEl.className = type ? type : '';
  }

  function showError(text) {
    setMessage(text, 'error');
  }

  function showOk(text) {
    setMessage(text, 'ok');
  }

  async function apiFetchJson(method, path, body) {
    const upper = String(method ?? "").toUpperCase()
    const isBodyMethod = upper === 'POST' || upper === 'PUT' || upper === 'PATCH'
    const fetchOptions = {
      method: upper,
      headers: { 'Content-Type': 'application/json' },
    }
    if (isBodyMethod) {
      fetchOptions.body = body === undefined ? JSON.stringify({}) : JSON.stringify(body)
    }

    const res = await fetch(API_BASE + path, fetchOptions);
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${t || res.statusText}`);
    }
    return res.json();
  }

  async function getStores() {
    return apiFetchJson('GET', '/admin/stores');
  }

  function setTab(tab) {
    const isPool = tab === 'pool';
    tabPool.classList.toggle('active', isPool);
    tabDirect.classList.toggle('active', !isPool);
    poolTabContent.classList.toggle('active', isPool);
    directTabContent.classList.toggle('active', !isPool);
  }

  async function fillStoreSelects() {
    const data = await getStores();
    const rows = (data && data.rows) ? data.rows : [];

    const fill = (sel) => {
      sel.innerHTML = '';
      for (const s of rows) {
        const opt = document.createElement('option');
        opt.value = s.storeCode;
        opt.textContent = `${s.name} (${s.storeCode})`;
        sel.appendChild(opt);
      }
    };

    fill(storeSelect);
    fill(directStoreSelect);
  }

  async function captureFromActiveTab() {
    const tab = await new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const t = tabs && tabs[0] ? tabs[0] : null;
        if (!t || !t.id) return reject(new Error('No active tab'));
        resolve(t);
      });
    });

    const response = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE' }, (resp) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(resp);
      });
    });

    return response;
  }

  async function captureAndExtract() {
    setMessage('Capturing from Amazon...', '');
    const captured = await captureFromActiveTab();
    if (!captured || captured.ok !== true) {
      throw new Error(captured && captured.error ? captured.error : 'Capture failed');
    }
    const data = captured.data;

    setMessage('Uploading to backend (product/extract)...', '');
    const res = await apiFetchJson('POST', '/admin/product/extract', data);
    if (!res || res.success !== true) throw new Error(res && res.error ? res.error : 'extract failed');
    return res;
  }

  async function onCapturePool() {
    try {
      setMessage('');
      const storeCode = storeSelect.value;
      if (!storeCode) return showError('Select a store');
      await captureAndExtract();
      showOk('✓ Added to pool (scrape queued via backend).');
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onCaptureDirect() {
    try {
      setMessage('');
      const storeCode = directStoreSelect.value;
      if (!storeCode) return showError('Select a store');
      const quantity = Math.max(1, parseInt(directQuantityInput.value || '1', 10) || 1);

      await captureAndExtract();

      setMessage('Dispatch + publish (listing/run)...', '');
      // listing/run will dispatch one candidate from the pool and publish it.
      // Our freshly extracted item should be chosen if pool is small / priorities align.
      const res = await apiFetchJson('POST', '/admin/listing/run', {
        storeCode,
        count: 1,
        selectionMode: 'fifo',
        delaySeconds: 0,
        quantity,
        dryRun: false,
        simulationMode: false,
      });

      showOk(`✓ Listing run started. dispatched=${res && res.body && res.body.dispatch ? res.body.dispatch.selectedCount : 0}`);
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  }

  tabPool.addEventListener('click', () => setTab('pool'));
  tabDirect.addEventListener('click', () => setTab('direct'));
  btnCapturePool.addEventListener('click', () => void onCapturePool());
  btnCaptureDirect.addEventListener('click', () => void onCaptureDirect());

  // init
  fillStoreSelects()
    .then(() => setMessage('Ready.', ''))
    .catch((e) => showError(e instanceof Error ? e.message : String(e)));
})();

