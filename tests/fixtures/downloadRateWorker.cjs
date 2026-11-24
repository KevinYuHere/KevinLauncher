const { parentPort } = require('node:worker_threads')
const { readBodyThrottled } = require('../../src/main/services/rateLimit.ts')

parentPort.on('message', async url => {
  const response = await fetch(url)
  parentPort.postMessage('headers')
  const bytes = await readBodyThrottled(response)
  parentPort.postMessage(bytes.length)
})
parentPort.postMessage('ready')
