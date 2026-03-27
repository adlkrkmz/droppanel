const API_BASE = 'http://localhost:4000'
let workerBusy = false

chrome.runtime.onInstalled.addListener(function() {
  console.log('DropPanel extension installed.')
  chrome.storage.local.get('droppanel_worker_id', function(result) {
    if (!result.droppanel_worker_id) {
      var id = 'worker-' + Math.random().toString(36).substr(2, 12) + '-' + Math.random().toString(36).substr(2, 12)
      chrome.storage.local.set({ droppanel_worker_id: id })
    }
    chrome.alarms.create('droppanel_poll', { periodInMinutes: 0.05 })
  })
})

chrome.runtime.onStartup.addListener(function() {
  chrome.storage.local.get('droppanel_worker_id', function(result) {
    if (!result.droppanel_worker_id) {
      var id = 'worker-' + Math.random().toString(36).substr(2, 12) + '-' + Math.random().toString(36).substr(2, 12)
      chrome.storage.local.set({ droppanel_worker_id: id })
    }
    chrome.alarms.create('droppanel_poll', { periodInMinutes: 0.05 })
  })
})

chrome.alarms.onAlarm.addListener(function(alarm) {
  if (alarm.name === 'droppanel_poll') {
    pollForJob()
  }
})

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

async function reportFailed(job, stage, errorMsg, wId) {
  console.error('[Worker] reportFailed:', stage, errorMsg)
  try {
    await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
      jobId: parseInt(job.id, 10),
      workerId: wId,
      status: 'failed',
      error: errorMsg,
      failedStage: stage
    })
  } catch(e) {}
  workerBusy = false
}

async function pollForJob() {
  var stored = await new Promise(function(resolve) {
    chrome.storage.local.get('droppanel_worker_id', function(r) { resolve(r) })
  })
  var wId = stored.droppanel_worker_id
  if (!wId) return
  console.log('[Worker] polling...')
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
  } catch(e) {
    // cleanup-stale hatası kritik değil, devam et
  }
  if (workerBusy) return
  try {
    var claimRes = await apiFetchJson('POST', '/admin/dispatch-jobs/claim-next', {
      workerId: wId,
      storeCode: null
    })
    if (!claimRes || !claimRes.job) return
    workerBusy = true
    await processJob(claimRes.job, wId)
  } catch(e) {
    console.error('[Worker] pollForJob failed:', e && e.message ? e.message : String(e))
  }
}

async function processJob(job, wId) {
  console.log('[Worker] processing job:', job.id, job.asin)
  try {
    await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
      jobId: parseInt(job.id, 10),
      workerId: wId,
      status: 'extract_running'
    })
    var url = 'https://www.amazon.com/dp/' + job.asin
    console.log('[Worker] creating tab for:', url)
    var tab = await new Promise(function(resolve, reject) {
      chrome.tabs.create({ url: url, active: false }, function(t) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
        } else {
          resolve(t)
        }
      })
    })
    await waitForTabLoad(tab.id)
    console.log('[Worker] tab loaded')
    await sleep(1500)
    var captureRes = await new Promise(function(resolve) {
      chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE' }, function(response) {
        resolve(response)
      })
    })
    chrome.tabs.remove(tab.id)
    if (!captureRes || !captureRes.ok) {
      await reportFailed(job, 'extract', captureRes ? captureRes.error : 'No response', wId)
      return
    }
    await apiFetchJson('POST', '/admin/product/extract', captureRes.data)
    await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
      jobId: parseInt(job.id, 10),
      workerId: wId,
      status: 'extract_done'
    })
    await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
      jobId: parseInt(job.id, 10),
      workerId: wId,
      status: 'ai_running'
    })
    await apiFetchJson('POST', '/admin/ai-listing/generate', { asin: job.asin })
    await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
      jobId: parseInt(job.id, 10),
      workerId: wId,
      status: 'ai_done'
    })
    await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
      jobId: parseInt(job.id, 10),
      workerId: wId,
      status: 'listing_running'
    })
    await apiFetchJson('POST', '/admin/pool/dispatch-selected', {
      storeCode: job.storeCode,
      poolIds: [parseInt(job.poolId, 10)]
    })
    await apiFetchJson('POST', '/admin/listing/run', {
      storeCode: job.storeCode,
      count: 1,
      dryRun: false,
      simulationMode: false,
      quantity: job.quantity,
      delaySeconds: 0
    })
    await apiFetchJson('POST', '/admin/dispatch-jobs/report', {
      jobId: parseInt(job.id, 10),
      workerId: wId,
      status: 'listing_done'
    })
    await sleep(job.delaySeconds * 1000)
    workerBusy = false
  } catch(e) {
    await reportFailed(job, 'extract', e && e.message ? e.message : String(e), wId)
  }
}

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === 'GET_WORKER_STATUS') {
    chrome.storage.local.get('droppanel_worker_id', function(result) {
      sendResponse({ workerId: result.droppanel_worker_id || null, busy: workerBusy })
    })
    return true
  }
})
