;(function () {
  'use strict'

  function notifyReady() {
    window.postMessage({ type: 'DP_EXTENSION_READY' }, '*')
  }

  // Panel page → Extension background
  window.addEventListener('message', function (event) {
    if (event.source !== window) return
    const data = event.data
    if (!data || typeof data.type !== 'string') return

    // Direct ping — respond immediately without going to background
    if (data.type === 'DP_PING') {
      notifyReady()
      return
    }

    if (!data.type.startsWith('DP_TO_BG_')) return

    const msg = Object.assign({}, data, { type: data.type.slice('DP_TO_BG_'.length) })
    chrome.runtime.sendMessage(msg, function (response) {
      if (chrome.runtime.lastError) return
      // Forward response back to page if present
      if (response) {
        window.postMessage(Object.assign({}, response, { type: 'DP_BG_RESP_' + msg.type }), '*')
      }
    })
  })

  // Extension background → Panel page
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false
    window.postMessage(msg, '*')
    sendResponse({ ok: true })
    return false
  })

  // Send ready signal immediately and again after a short delay
  notifyReady()
  setTimeout(notifyReady, 300)
  setTimeout(notifyReady, 800)
})()
