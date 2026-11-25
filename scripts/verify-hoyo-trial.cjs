// Run with Node 24 or Electron's Node mode. Only a loopback CDN, a generated
// one-file game, and an empty temporary userData directory are used.
const assert = require('node:assert/strict')
const { createHash, randomBytes } = require('node:crypto')
const fs = require('node:fs/promises')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { zstdCompressSync } = require('node:zlib')

const hash = data => createHash('md5').update(data).digest('hex')
function integer(n) {
  const bytes = []
  while (n > 127) { bytes.push((n & 127) | 128); n = Math.floor(n / 128) }
  return Buffer.from([...bytes, n])
}
const num = (tag, value) => Buffer.concat([integer(tag * 8), integer(value)])
function field(tag, value) {
  const bytes = Buffer.from(value)
  return Buffer.concat([integer(tag * 8 + 2), integer(bytes.length), bytes])
}

function createChunkFixture(prefix, payload) {
  const compressed = zstdCompressSync(payload)
  const name = '游戏 资源.bin'
  const chunk = Buffer.concat([field(1, 'chunk'), field(2, hash(payload)), num(4, compressed.length),
    num(5, payload.length), field(7, hash(compressed))])
  const manifest = field(1, Buffer.concat([field(1, name), field(2, chunk), num(4, payload.length), field(5, hash(payload))]))
  const files = { '/fixtures/manifest': zstdCompressSync(manifest), '/fixtures/chunk': compressed }
  const build = { buildId: 'fixture', tag: '2.0', categories: [{ categoryId: 'base', matchingField: 'game',
    manifestId: 'manifest', manifestSize: manifest.length, manifestMd5: hash(manifest), manifestCompression: 1,
    manifestUrlPrefix: prefix + '/fixtures', manifestSuffix: '', chunkCompression: 1,
    chunkUrlPrefix: prefix + '/fixtures', chunkSuffix: '', compressedSize: compressed.length }] }
  return { name, files, build }
}

async function runWorker(file, setup, start = path => new Worker(path)) {
  const worker = start(file)
  let unsubscribe = () => {}
  function send(command) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('游戏工作线程超时：' + command.type)), 30000)
      const exit = code => finish(new Error('游戏工作线程退出：' + code))
      const receive = msg => {
        if (msg.type === 'done') finish()
        if (msg.type === 'error') finish(new Error(msg.message))
      }
      function finish(error) {
        unsubscribe()
        if (error) reject(error)
        else resolve()
      }
      unsubscribe = () => {
        clearTimeout(timer)
        worker.off('message', receive).off('error', finish).off('exit', exit)
      }
      worker.on('message', receive).on('error', finish).once('exit', exit)
      worker.postMessage(command)
    })
  }
  try {
    await send({ type: 'prepare', setup })
    await send({ type: 'update' })
    await send({ type: 'verify' })
    await send({ type: 'dispose' })
  } finally {
    unsubscribe()
    await worker.terminate()
  }
}

async function verify() {
  const out = path.resolve(process.argv[2] || 'out', 'main')
  const workerFile = (await fs.readdir(out)).find(f => /^sophonWorker-.*\.js$/.test(f))
  assert.ok(workerFile)
  const root = await fs.mkdtemp(path.join(tmpdir(), 'kl-hoyo-trial-'))
  const payload = randomBytes(8192)
  const requests = { manifest: 0, chunk: 0 }
  let offline = false
  let files
  const server = createServer((req, res) => {
    if (req.url === '/fixtures/manifest') requests.manifest++
    if (req.url === '/fixtures/chunk') requests.chunk++
    if (offline || !files[req.url]) res.writeHead(404).end()
    else res.end(files[req.url])
  })
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    const prefix = 'http://127.0.0.1:' + server.address().port
    const fixture = createChunkFixture(prefix, payload)
    const { build, name } = fixture
    files = fixture.files
    const userData = path.join(root, '资料')
    await fs.mkdir(userData)
    const first = path.join(root, '安装 A')
    const second = path.join(root, '安装 B')
    let initialRequests
    for (const dir of [first, second]) {
      await fs.mkdir(dir)
      await runWorker(path.join(out, workerFile), { dir, userData, gameId: 'fixture', launcherVersion: 'trial',
        plan: { kind: 'chunk', build, mainBuild: build }, version: '1.0', predownload: false,
        blacklist: [], hpatchz: '' })
      assert.deepEqual(await fs.readFile(path.join(dir, name)), payload)
      if (!offline) {
        assert.ok(requests.manifest && requests.chunk)
        initialRequests = { ...requests }
        offline = true
      }
    }
    assert.deepEqual(requests, initialRequests)
    const one = await fs.stat(path.join(first, name), { bigint: true })
    const two = await fs.stat(path.join(second, name), { bigint: true })
    assert.equal(one.ino, two.ino)
    assert.ok(two.nlink >= 2n)
    console.log(JSON.stringify({ firstRequests: initialRequests, secondRequests: 0, linkedBytes: payload.length, electron: process.versions.electron }))
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('kl-hoyo-trial-')) {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}

module.exports = { createChunkFixture, runWorker }
if (require.main === module) verify().catch(error => { console.error(error); process.exitCode = 1 })
