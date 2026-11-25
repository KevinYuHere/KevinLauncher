// Run "node scripts/verify-hoyo-http2.cjs" with the installed project dependencies.
const assert = require('node:assert/strict')
const { createHash, X509Certificate } = require('node:crypto')
const fs = require('node:fs/promises')
const http2 = require('node:http2')
const https = require('node:https')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

async function electronClient() {
  const { app } = require('electron')
  app.disableHardwareAcceleration()
  await app.whenReady()
  const { electronHoYoFetch } = require(process.env.KL_HTTP_TEST_TRANSPORT)
  const evidence = []
  for (const test of JSON.parse(process.env.KL_HTTP_TEST_CASES)) {
    for (const role of ['desktop', 'runner']) {
      const url = test.origin + '/' + role
      const whole = await electronHoYoFetch(role, url, { signal: AbortSignal.timeout(10000) })
      assert.equal(whole.status, 200)
      const bytes = Buffer.from(await whole.arrayBuffer())
      assert.equal(bytes.length, test.size)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), test.digest)
      const slice = await electronHoYoFetch(role, url, { headers: { Range: 'bytes=257-383' }, signal: AbortSignal.timeout(10000) })
      assert.equal(slice.status, 206)
      assert.equal(slice.headers.get('Content-Range'), 'bytes 257-383/' + test.size)
      const partial = Buffer.from(await slice.arrayBuffer())
      assert.deepEqual(partial, bytes.subarray(257, 384))
      evidence.push({ role, alpn: test.alpn, full: bytes.length, range: partial.length })
    }
  }
  console.log(JSON.stringify({ electron: process.versions.electron, chromium: process.versions.chrome, evidence }))
  app.exit(0)
}

async function verify() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'kl-hoyo-alpn-'))
  const cert = await fs.readFile(path.join(__dirname, '../tests/fixtures/hoyo-tls-cert.pem'))
  const key = await fs.readFile(path.join(__dirname, '../tests/fixtures/hoyo-tls-key.pem'))
  const publicKey = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })
  const fingerprint = createHash('sha256').update(publicKey).digest('base64')
  const payload = Buffer.alloc(32781)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 19 + (i >>> 8)) & 255
  const digest = createHash('sha256').update(payload).digest('hex')
  const servers = [], sockets = new Set(), cases = [], requests = []
  try {
    for (const [alpn, version] of [['h2', '2.0'], ['http/1.1', '1.1']]) {
      const respond = (req, res) => {
        const range = req.headers.range
        const selected = range ? payload.subarray(257, 384) : payload
        const headers = { 'Content-Length': selected.length, 'Cache-Control': 'no-store' }
        if (range) headers['Content-Range'] = 'bytes 257-383/' + payload.length
        requests.push({ alpn: req.socket.alpnProtocol, version: req.httpVersion, path: req.url, range, bytes: selected.length })
        res.writeHead(range ? 206 : 200, headers).end(selected)
      }
      const server = alpn === 'h2' ? http2.createSecureServer({ cert, key }, respond)
        : https.createServer({ cert, key, ALPNProtocols: ['http/1.1'] }, respond)
      server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
      await new Promise((ready, fail) => server.once('error', fail).listen(0, '127.0.0.1', ready))
      servers.push(server)
      cases.push({ origin: 'https://127.0.0.1:' + server.address().port, version, alpn, size: payload.length, digest })
    }
    const transport = path.join(root, 'transport.cjs')
    await require('esbuild').build({ entryPoints: [path.join(__dirname, '../src/main/update/hoyoTransport.ts')], outfile: transport,
      format: 'cjs', platform: 'node', bundle: true, external: ['electron'], logLevel: 'silent' })
    const env = { ...process.env, KL_HTTP_TEST_TRANSPORT: transport, KL_HTTP_TEST_CASES: JSON.stringify(cases) }
    delete env.ELECTRON_RUN_AS_NODE
    await new Promise((ok, fail) => {
      const child = spawn(require('electron'), ['--user-data-dir=' + path.join(root, 'profile'),
        '--ignore-certificate-errors-spki-list=' + fingerprint, '--disable-background-networking', __filename, '--client'],
        { env, stdio: 'inherit', windowsHide: true })
      const timer = setTimeout(() => child.kill(), 45000)
      child.once('error', error => { clearTimeout(timer); fail(error) })
      child.once('close', code => { clearTimeout(timer); if (code === 0) ok(); else fail(new Error('Electron exit ' + code)) })
    })
    const expect = []
    for (const { alpn, version } of cases) for (const role of ['desktop', 'runner']) {
      expect.push({ alpn, version, path: '/' + role, range: undefined, bytes: payload.length },
        { alpn, version, path: '/' + role, range: 'bytes=257-383', bytes: 127 })
    }
    assert.deepEqual(requests, expect)
    console.log(JSON.stringify({ sha256: digest, requests }))
  } finally {
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(server => new Promise(done => server.close(done))))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
  }
}

const client = process.argv.includes('--client')
void (client ? electronClient() : verify()).catch(error => {
  console.error(error)
  if (client) require('electron').app.exit(1)
  else process.exitCode = 1
})
