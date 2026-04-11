const API_BASE = 'http://localhost:4000'
let workerBusy = false

// ─── Worker ID — yoksa otomatik oluştur ──────────────────────────────────────
function ensureWorkerId(callback) {
  chrome.storage.local.get('droppanel_worker_id', function(r) {
    if (r.droppanel_worker_id) {
      callback(r.droppanel_worker_id)
      return
    }
    var newId = 'w-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now()
    chrome.storage.local.set({ droppanel_worker_id: newId }, function() {
      console.log('[Worker] Generated worker_id:', newId)
      callback(newId)
    })
  })
}

// ─── setTimeout polling — alarms yerine daha güvenilir ───────────────────────
function startPolling() {
  setTimeout(async function poll() {
    try { await pollForJob() } catch(e) {
      console.error('[Worker] poll error:', e && e.message ? e.message : String(e))
    }
    setTimeout(poll, 15000) // 15 saniyede bir
  }, 2000)
}

chrome.runtime.onInstalled.addListener(function() {
  console.log('[DropPanel] Extension installed.')
  ensureWorkerId(function() { startPolling() })
})

chrome.runtime.onStartup.addListener(function() {
  ensureWorkerId(function() { startPolling() })
})

startPolling() // Service worker başladığında hemen başlat

// ─── API helpers ─────────────────────────────────────────────────────────────
async function apiFetchJson(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) {
    const text = await res.text().catch(function() { return '' })
    throw new Error('API ' + res.status + ' ' + res.statusText + ': ' + text)
  }
  return res.json()
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms) })
}

function waitForTabLoad(tabId) {
  return new Promise(function(resolve, reject) {
    var attempts = 0
    var interval = setInterval(function() {
      attempts++
      chrome.tabs.get(tabId, function(tab) {
        if (chrome.runtime.lastError) {
          clearInterval(interval)
          reject(new Error('Tab not found'))
          return
        }
        if (tab && tab.status === 'complete') {
          clearInterval(interval)
          resolve()
        }
        if (attempts > 30) {
          clearInterval(interval)
          resolve()
        }
      })
    }, 500)
  })
}

// ─── Worker ──────────────────────────────────────────────────────────────────
async function reportFailed(job, stage, errorMsg, wId) {
  console.error('[Worker] reportFailed:', stage, errorMsg)
  try {
    await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
      jobId:       parseInt(job.id, 10),
      workerId:    wId,
      status:      'failed',
      error:       errorMsg,
      failedStage: stage
    })
  } catch(e) {}
  workerBusy = false
}

async function pollForJob() {
  var wId = await new Promise(function(resolve) {
    ensureWorkerId(resolve)
  })

  console.log('[Worker] polling... wId:', wId)

  // Stale iş temizliği — hata kritik değil
  try {
    const controller = new AbortController()
    const timeout = setTimeout(function() { controller.abort() }, 3000)
    try {
      await fetch(API_BASE + '/admin/dispatch-jobs/cleanup-stale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerId: wId }),
        signal: controller.signal
      })
    } finally {
      clearTimeout(timeout)
    }
  } catch(e) {}

  if (workerBusy) return

  try {
    var claimRes = await apiFetchJson('POST', '/admin/dispatch-jobs/claim-next', {
      workerId:  wId,
      storeCode: null
    })
    if (!claimRes || !claimRes.job) return
    workerBusy = true
    await processJob(claimRes.job, wId)
  } catch(e) {
    console.error('[Worker] pollForJob error:', e && e.message ? e.message : String(e))
  }
}

async function processJob(job, wId) {
  const JOB_TIMEOUT_MS = 60000
  const jobType = job.jobType || 'scrape_and_list'
  let openTabId = null
  let done = false

  console.log('[Worker] Processing job:', job.id, '| ASIN:', job.asin, '| type:', jobType)

  // 60 saniye timeout — donma koruması
  const timeoutHandle = setTimeout(function() {
    if (done) return
    done = true
    console.error('[Worker] Job timeout (60s):', job.id, job.asin)
    if (openTabId !== null) {
      try { chrome.tabs.remove(openTabId) } catch(e) {}
      openTabId = null
    }
    apiFetchJson('POST', '/admin/dispatch-jobs/report', {
      jobId:       parseInt(job.id, 10),
      workerId:    wId,
      status:      'failed',
      error:       'Timeout (60s)',
      failedStage: 'extract'
    }).catch(function() {})
    workerBusy = false
  }, JOB_TIMEOUT_MS)

  try {

    // ─── list_only: ai_generated ürün, scrape/AI gerekmez ──────────────────
    if (jobType === 'list_only') {
      clearTimeout(timeoutHandle)
      done = true
      await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
        jobId: parseInt(job.id, 10), workerId: wId, status: 'ai_done'
      })
      await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
        jobId: parseInt(job.id, 10), workerId: wId, status: 'listing_done'
      })
      console.log('[Worker] list_only done:', job.id, '| ASIN:', job.asin)
      workerBusy = false
      return
    }

    // ─── scrape_and_list: validated — Amazon'dan scrape et ─────────────────
    if (jobType === 'scrape_and_list') {
      await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
        jobId: parseInt(job.id, 10), workerId: wId, status: 'extract_running'
      })

      var url = 'https://www.amazon.com/dp/' + job.asin
      var tab = await new Promise(function(resolve, reject) {
        chrome.tabs.create({ url: url, active: false }, function(t) {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
          else resolve(t)
        })
      })
      openTabId = tab.id

      await waitForTabLoad(tab.id)
      await sleep(1500)

      var captureRes = await new Promise(function(resolve) {
        chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE' }, function(response) {
          if (chrome.runtime.lastError) resolve(null)
          else resolve(response)
        })
      })

      try { chrome.tabs.remove(tab.id) } catch(e) {}
      openTabId = null

      if (!captureRes || !captureRes.ok) {
        throw new Error(captureRes && captureRes.error ? captureRes.error : 'CAPTURE yanıtsız')
      }

      await apiFetchJson('POST', '/admin/product/extract', captureRes.data)
      await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
        jobId: parseInt(job.id, 10), workerId: wId, status: 'extract_done'
      })
    }

    // ─── ai_and_list + scrape_and_list: AI üret ────────────────────────────
    await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
      jobId: parseInt(job.id, 10), workerId: wId, status: 'ai_running'
    })
    await apiFetchJson('POST', '/admin/ai-listing/generate', { asin: job.asin })

    // ─── Tamamlandı ─────────────────────────────────────────────────────────
    clearTimeout(timeoutHandle)
    done = true
    await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
      jobId: parseInt(job.id, 10), workerId: wId, status: 'ai_done'
    })
    // listing_done — run counter "completed" sayısını günceller
    await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
      jobId: parseInt(job.id, 10), workerId: wId, status: 'listing_done'
    })
    console.log('[Worker] Job done:', job.id, '| ASIN:', job.asin, '| type:', jobType)

  } catch(e) {
    clearTimeout(timeoutHandle)
    if (done) return
    done = true
    var msg = e && e.message ? e.message : String(e)
    console.error('[Worker] processJob error:', msg)
    if (openTabId !== null) {
      try { chrome.tabs.remove(openTabId) } catch(e2) {}
      openTabId = null
    }
    await reportFailed(job, jobType === 'ai_and_list' ? 'ai' : 'extract', msg, wId)
    return
  }

  workerBusy = false
}

// ─── Scan state ──────────────────────────────────────────────────────────────
let scanRunning    = false
let activeScanTabId = null
let activePanelTabId = null

function waitForTabUrlChange(tabId, oldUrl, timeout) {
  timeout = timeout || 15000
  return new Promise(function (resolve) {
    var deadline = Date.now() + timeout
    var interval = setInterval(function () {
      chrome.tabs.get(tabId, function (tab) {
        if (chrome.runtime.lastError) { clearInterval(interval); resolve(false); return }
        if (tab && tab.url && tab.url !== oldUrl) { clearInterval(interval); resolve(true); return }
        if (Date.now() >= deadline) { clearInterval(interval); resolve(false) }
      })
    }, 400)
  })
}

async function waitForSearchReady(tabId, timeout) {
  timeout = timeout || 18000
  var deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!scanRunning) return false
    try {
      var res = await new Promise(function (resolve) {
        chrome.tabs.sendMessage(tabId, { type: 'SEARCH_CHECK_READY' }, function (r) {
          if (chrome.runtime.lastError) resolve(null)
          else resolve(r)
        })
      })
      if (res && res.ready) return true
    } catch (e) {}
    await sleep(600)
  }
  return false
}

async function sendToPanel(data) {
  if (!activePanelTabId) return
  try {
    await new Promise(function (resolve) {
      chrome.tabs.sendMessage(activePanelTabId, data, function () {
        if (chrome.runtime.lastError) {}
        resolve()
      })
    })
  } catch (e) {}
}

async function findOpenAmazonTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ url: 'https://www.amazon.com/*' }, function (tabs) {
      if (chrome.runtime.lastError || !tabs || tabs.length === 0) { resolve(null); return }
      for (var i = 0; i < tabs.length; i++) {
        var url = tabs[i].url || ''
        if (url.includes('amazon.com/s') || url.includes('amazon.com/s?')) {
          resolve(tabs[i].id); return
        }
      }
      resolve(tabs[0].id)
    })
  })
}

async function runScan(options) {
  var amazonUrl   = options.amazonUrl
  var filters     = options.filters || {}
  var pageCount   = options.pageCount || 3
  var allPassed   = []
  var allRejected = []
  var totalSkippedBrand = 0
  var seenPassed   = new Set()
  var seenRejected = new Set()

  try {
    await sendToPanel({ type: 'DP_SCAN_PROGRESS', phase: 'opening', page: 0, total: pageCount, count: 0 })

    var existingTabId = await findOpenAmazonTab()
    if (existingTabId !== null) {
      activeScanTabId = existingTabId
      await new Promise(function (resolve) {
        chrome.tabs.update(existingTabId, { url: amazonUrl, active: true }, resolve)
      })
    } else {
      var newTab = await new Promise(function (resolve, reject) {
        chrome.tabs.create({ url: amazonUrl, active: true }, function (t) {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
          else resolve(t)
        })
      })
      activeScanTabId = newTab.id
    }

    await waitForTabLoad(activeScanTabId)
    await sleep(1200)

    for (var page = 0; page < pageCount; page++) {
      if (!scanRunning) break

      await sendToPanel({ type: 'DP_SCAN_PROGRESS', phase: 'scanning', page: page + 1, total: pageCount, count: allPassed.length })

      var ready = await waitForSearchReady(activeScanTabId)
      if (!ready) {
        await sendToPanel({ type: 'DP_SCAN_PROGRESS', phase: 'not_ready', page: page + 1, total: pageCount, count: allPassed.length })
        break
      }

      await sleep(800)

      try {
        var scanRes = await new Promise(function (resolve) {
          chrome.tabs.sendMessage(activeScanTabId, { type: 'SEARCH_SCAN_PAGE', filters: filters }, function (r) {
            if (chrome.runtime.lastError) resolve(null)
            else resolve(r)
          })
        })
        if (scanRes && scanRes.ok) {
          var pagePassed = scanRes.passed || []
          for (var i = 0; i < pagePassed.length; i++) {
            var c = pagePassed[i]
            if (!seenPassed.has(c.asin)) {
              seenPassed.add(c.asin)
              allPassed.push(c)
            }
          }
          var pageRejected = scanRes.rejected || []
          for (var j = 0; j < pageRejected.length; j++) {
            var item = pageRejected[j]
            var rasin = item.candidate.asin
            if (!seenPassed.has(rasin) && !seenRejected.has(rasin)) {
              seenRejected.add(rasin)
              allRejected.push(item)
            }
          }
          totalSkippedBrand += (scanRes.skippedBrand || 0)
        }
      } catch (e) {}

      await sendToPanel({ type: 'DP_SCAN_PROGRESS', phase: 'scanning', page: page + 1, total: pageCount, count: allPassed.length })

      if (page < pageCount - 1 && scanRunning) {
        var currentTab = await new Promise(function (resolve) {
          chrome.tabs.get(activeScanTabId, function (t) { resolve(t) })
        })
        var urlBefore = currentTab ? currentTab.url : ''

        var nextRes = await new Promise(function (resolve) {
          chrome.tabs.sendMessage(activeScanTabId, { type: 'SEARCH_CLICK_NEXT' }, function (r) {
            if (chrome.runtime.lastError) resolve(null)
            else resolve(r)
          })
        })
        if (!nextRes || !nextRes.ok) break

        var changed = await waitForTabUrlChange(activeScanTabId, urlBefore, 15000)
        if (!changed) break
        await sleep(1500)
      }
    }

    activeScanTabId = null

    await sendToPanel({
      type:         'DP_SCAN_DONE',
      passed:       allPassed,
      rejected:     allRejected,
      skippedBrand: totalSkippedBrand,
      count:        allPassed.length,
    })
  } catch (e) {
    activeScanTabId = null
    await sendToPanel({ type: 'DP_SCAN_ERROR', error: e && e.message ? e.message : String(e) })
  } finally {
    scanRunning = false
  }
}

// ─── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === 'GET_WORKER_STATUS') {
    chrome.storage.local.get('droppanel_worker_id', function(result) {
      sendResponse({ workerId: result.droppanel_worker_id || null, busy: workerBusy })
    })
    return true
  }

  if (msg.type === 'SCAN_START') {
    if (scanRunning) {
      sendResponse({ ok: false, error: 'Scan already running' })
      return false
    }
    activePanelTabId = sender.tab ? sender.tab.id : null
    scanRunning = true
    runScan(msg).catch(console.error)
    sendResponse({ ok: true })
    return false
  }

  if (msg.type === 'SCAN_STOP') {
    scanRunning = false
    if (activeScanTabId) {
      try { chrome.tabs.remove(activeScanTabId) } catch (e) {}
      activeScanTabId = null
    }
    sendResponse({ ok: true })
    return false
  }

  if (msg.type === 'SCAN_STATUS') {
    sendResponse({ running: scanRunning })
    return false
  }
})
