/**
 * DropPanel — popup logic
 * Pool tab: CAPTURE -> POST /admin/product/extract
 * Direct List tab: capture -> extract -> AI generate -> import -> dispatch -> listing/run
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
        opt.textContent = (s.name && String(s.name).trim()) ? String(s.name).trim() : s.storeCode;
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
    setMessage('Uploading to backend...', '');
    await apiFetchJson('POST', '/admin/product/extract', captured.data);
    return captured.data;
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

      // 1. Capture from Amazon
      setMessage('Capturing from Amazon...', '');
      const captured = await captureFromActiveTab();
      if (!captured || captured.ok !== true) {
        throw new Error(captured && captured.error ? captured.error : 'Capture failed');
      }
      const asin = captured.data.asin;

      // 2. Extract
      setMessage('Extracting product data...', '');
      await apiFetchJson('POST', '/admin/product/extract', captured.data);

      // 3. AI generate
      setMessage('Generating AI listing...', '');
      await apiFetchJson('POST', '/admin/ai-listing/generate', { asin });

      // 4. Import to pool
      setMessage('Adding to pool...', '');
      await apiFetchJson('POST', '/admin/asins/import', { asins: [asin] });
      // /admin/pool ASIN filtresini desteklemediğinden DB'ye yazılması için bekle
      await new Promise(r => setTimeout(r, 2000));

      // 5. Get pool entry
      const poolData = await apiFetchJson('GET', '/admin/pool?status=ready&limit=1000');
      console.log('[DirectList] pool rows count:', poolData.rows?.length);
      console.log('[DirectList] searching for asin:', asin);
      const poolEntry = (poolData.rows || []).find((r) => r.asin === asin);
      if (!poolEntry) throw new Error('ASIN not found in pool after import');
      console.log('[DirectList] ASIN:', asin);
      console.log('[DirectList] poolEntry:', JSON.stringify(poolEntry));

      // 6. Dispatch to store
      setMessage('Dispatching to store...', '');
      await apiFetchJson('POST', '/admin/pool/dispatch-selected', {
        storeCode,
        poolIds: [poolEntry.poolId],
      });

      // 7. Listing run — poolIds ile doğrudan bu ürünü hedefle
      setMessage('Publishing to eBay...', '');
      const runRes = await apiFetchJson('POST', '/admin/listing/run', {
        storeCode,
        count: 1,
        selectionMode: 'fifo',
        delaySeconds: 0,
        quantity,
        dryRun: false,
        simulationMode: false,
        poolIds: [poolEntry.poolId],
      });
      console.log('[DirectList] listing/run result:', JSON.stringify(runRes));
      if (!runRes || runRes.publish?.succeeded === 0) {
        const errMsg = runRes?.publish?.failed > 0 ? 'eBay yükleme başarısız oldu.' : 'Yüklenemedi.';
        throw new Error(errMsg);
      }

      showOk('✓ Başarıyla listelendi!');
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);

      // eBay hata kodlarını Türkçeye çevir
      if (msg.includes('Pesticides') || msg.includes('1194569')) {
        msg = '❌ Bu ürün eBay\'de yasaklı kategoride (Pestisit). Yüklenemez.';
      } else if (msg.includes('Item Width') || msg.includes('Item Length') || msg.includes('Item Height')) {
        msg = '❌ Ürün boyutları eksik. eBay bu kategori için ölçü bilgisi istiyor.';
      } else if (msg.includes('not found in pool')) {
        msg = '❌ Ürün havuza eklenemedi. Tekrar deneyin.';
      } else if (msg.includes('Capture failed') || msg.includes('Could not find')) {
        msg = '❌ Amazon sayfası okunamadı. Amazon ürün sayfasında olduğunuzdan emin olun.';
      } else if (msg.includes('400') || msg.includes('publishOffer')) {
        msg = '❌ eBay\'e yüklenemedi: ' + msg.slice(0, 100);
      } else if (msg.includes('Failed to fetch')) {
        msg = '❌ Backend\'e bağlanılamadı. Backend çalışıyor mu?';
      }

      showError(msg);
    }
  }

  async function onCaptureDirectTemu() {
    try {
      setMessage('')
      const temuPriceVal = parseFloat(document.getElementById('temuPrice').value)
      const temuPriceError = document.getElementById('temuPriceError')
      if (!temuPriceVal || temuPriceVal <= 0) {
        temuPriceError.style.display = 'block'
        document.getElementById('temuPrice').style.border = '1.5px solid #dc2626'
        return
      }
      temuPriceError.style.display = 'none'
      document.getElementById('temuPrice').style.border = ''

      const storeCode = directStoreSelect.value
      if (!storeCode) return showError('Mağaza seçin')
      const quantity = Math.max(1, parseInt(directQuantityInput.value || '1', 10) || 1)

      setMessage('Temu sayfası okunuyor...', '')
      const captured = await new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const t = tabs?.[0]
          if (!t?.id) return reject(new Error('Tab bulunamadı'))
          chrome.tabs.sendMessage(t.id, { type: 'CAPTURE_TEMU' }, (resp) => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError)
            resolve(resp)
          })
        })
      })

      if (!captured || !captured.ok) {
        throw new Error(captured?.error || 'Temu capture başarısız')
      }

      captured.data.price = temuPriceVal
      captured.data.ebayListingPrice = temuPriceVal

      setMessage('Ürün kaydediliyor...', '')
      await apiFetchJson('POST', '/admin/product/extract', captured.data)

      setMessage('AI listing oluşturuluyor...', '')
      await apiFetchJson('POST', '/admin/ai-listing/generate', { asin: captured.data.asin })

      setMessage("Pool'a ekleniyor...", '')
      await apiFetchJson('POST', '/admin/asins/import', { asins: [captured.data.asin] })

      await new Promise(r => setTimeout(r, 2000))

      const poolData = await apiFetchJson('GET', '/admin/pool?status=ready')
      const poolEntry = (poolData.rows || []).find(r => r.asin === captured.data.asin)
      if (!poolEntry) throw new Error("Pool'da bulunamadı")

      setMessage("eBay'e yükleniyor...", '')
      await apiFetchJson('POST', '/admin/pool/dispatch-selected', {
        storeCode,
        poolIds: [poolEntry.poolId],
      })

      // poolIds ile doğrudan bu ürünü hedefle
      const runRes = await apiFetchJson('POST', '/admin/listing/run', {
        storeCode,
        count: 1,
        selectionMode: 'fifo',
        delaySeconds: 0,
        quantity,
        dryRun: false,
        simulationMode: false,
        poolIds: [poolEntry.poolId],
      })

      if (runRes?.publish?.succeeded === 0) {
        throw new Error('eBay yükleme başarısız')
      }

      showOk('✓ Temu ürünü listelendi!')
    } catch(e) {
      let msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('Temu sayfasında değil')) msg = '❌ Temu ürün sayfasında olun'
      showError(msg)
    }
  }

  async function onCaptureDirectAli() {
    try {
      setMessage('')
      const aliPriceVal = parseFloat(document.getElementById('aliPrice').value)
      const aliPriceError = document.getElementById('aliPriceError')
      if (!aliPriceVal || aliPriceVal <= 0) {
        aliPriceError.style.display = 'block'
        document.getElementById('aliPrice').style.border = '1.5px solid #dc2626'
        return
      }
      aliPriceError.style.display = 'none'
      document.getElementById('aliPrice').style.border = ''
      const storeCode = directStoreSelect.value
      if (!storeCode) return showError('Mağaza seçin')
      const quantity = Math.max(1, parseInt(directQuantityInput.value || '1', 10) || 1)
      setMessage('AliExpress sayfası okunuyor...', '')
      const captured = await new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const t = tabs?.[0]
          if (!t?.id) return reject(new Error('Tab bulunamadı'))
          chrome.tabs.sendMessage(t.id, { type: 'CAPTURE_ALIEXPRESS' }, (resp) => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError)
            resolve(resp)
          })
        })
      })
      if (!captured || !captured.ok) {
        throw new Error(captured?.error || 'AliExpress capture başarısız')
      }
      captured.data.price = aliPriceVal
      captured.data.ebayListingPrice = aliPriceVal
      setMessage('Ürün kaydediliyor...', '')
      await apiFetchJson('POST', '/admin/product/extract', captured.data)
      setMessage('AI listing oluşturuluyor...', '')
      await apiFetchJson('POST', '/admin/ai-listing/generate', { asin: captured.data.asin })
      setMessage("Pool'a ekleniyor...", '')
      await apiFetchJson('POST', '/admin/asins/import', { asins: [captured.data.asin] })
      await new Promise(r => setTimeout(r, 2000))
      const poolData = await apiFetchJson('GET', '/admin/pool?status=ready')
      const poolEntry = (poolData.rows || []).find(r => r.asin === captured.data.asin)
      if (!poolEntry) throw new Error("Pool'da bulunamadı")
      setMessage("eBay'e yükleniyor...", '')
      await apiFetchJson('POST', '/admin/pool/dispatch-selected', {
        storeCode,
        poolIds: [poolEntry.poolId],
      })
      const runRes = await apiFetchJson('POST', '/admin/listing/run', {
        storeCode,
        count: 1,
        selectionMode: 'fifo',
        delaySeconds: 0,
        quantity,
        dryRun: false,
        simulationMode: false,
        poolIds: [poolEntry.poolId],
      })
      if (runRes?.publish?.succeeded === 0) {
        throw new Error('eBay yükleme başarısız')
      }
      showOk('✓ AliExpress ürünü listelendi!')
    } catch(e) {
      let msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('AliExpress ürün sayfasında değilsiniz')) msg = '❌ AliExpress ürün sayfasında olun'
      showError(msg)
    }
  }

  const btnCaptureDirectTemu = document.getElementById('btnCaptureDirectTemu')

  tabPool.addEventListener('click', () => setTab('pool'));
  tabDirect.addEventListener('click', () => setTab('direct'));
  btnCapturePool.addEventListener('click', () => void onCapturePool());
  btnCaptureDirect.addEventListener('click', () => void onCaptureDirect());
  btnCaptureDirectTemu.addEventListener('click', () => void onCaptureDirectTemu());
  const btnCaptureDirectAli = document.getElementById('btnCaptureDirectAli')
  btnCaptureDirectAli.addEventListener('click', () => void onCaptureDirectAli())

  // init
  fillStoreSelects()
    .then(() => setMessage('Ready.', ''))
    .catch((e) => showError(e instanceof Error ? e.message : String(e)));
})();

