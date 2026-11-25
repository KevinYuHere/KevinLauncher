// Run after building. Exercises the actual bundled worker and native archive helper
// against synthetic files and a loopback HTTP server.
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createCipheriv, createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { MessageChannel, Worker } = require('node:worker_threads')

const digest = bytes => createHash('md5').update(bytes).digest('hex')
function versionMarker(version) {
  const key = Buffer.from('c0f30e1ce763bbc21cc355a34303ac50399444bff68c4a22af398c0a166ee143', 'hex')
  const iv = Buffer.from('33467861192750649501937264608400', 'hex')
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([cipher.update(`[Game]\nversion=${version}\n`), cipher.final()])
}

async function runWorker(file, message, onPhase) {
  const { port1, port2 } = new MessageChannel()
  port1.on('message', ({ id, bytes }) => { if (bytes != null) port1.postMessage(id) })
  const worker = new Worker(file, { workerData: { downloadRatePort: port2 }, transferList: [port2] })
  let terminal
  let failure
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => worker.terminate(), 15_000)
    worker.on('message', (value) => {
      if (value.type === 'done' || value.type === 'error') terminal = value
      onPhase?.(value, worker)
    })
    worker.once('error', (error) => { failure = error })
    worker.once('exit', (code) => {
      clearTimeout(timeout)
      port1.close()
      if (failure || code !== 0 || !terminal) reject(failure ?? new Error(`worker exit ${code}`))
      else resolve(terminal)
    })
    worker.postMessage(message)
  })
}

async function verify() {
  const out = path.resolve(process.argv[2] ?? path.join(__dirname, '../out'))
  const main = path.join(out, 'main')
  const worker = path.join(main, (await fs.readdir(main)).find(name => /^arknightsWorker-.*\.js$/.test(name)))
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'kl-ak-worker-'))
  const game = path.join(dir, '游戏 目录')
  const source = path.join(dir, '归档')
  const zip = path.join(dir, 'patch.zip')
  const server = createServer()
  try {
    await Promise.all([fs.mkdir(game), fs.mkdir(source)])
    const oldMarker = versionMarker('1.2.3')
    const newMarker = versionMarker('1.2.4')
    const manifest = Buffer.from(JSON.stringify({ version: '1.2.4', files: [] }))
    const files = Object.entries({ 'a.bin': Buffer.from('new A'), 'b.bin': Buffer.from('new B'),
      'config.ini': newMarker, 'patch.json': manifest, 'delete_files.txt': Buffer.from('old.bin\n') })
    await fs.writeFile(path.join(game, 'config.ini'), oldMarker)
    await fs.writeFile(path.join(game, 'a.bin'), 'old A')
    await fs.mkdir(path.join(game, 'b.bin'))
    await fs.writeFile(path.join(game, 'old.bin'), 'obsolete')
    await fs.writeFile(path.join(game, 'third-party.tmp'), 'keep')
    for (const [name, data] of files) await fs.writeFile(path.join(source, name), data)
    execFileSync('tar', ['-acf', zip, '-C', source, ...files.map(([name]) => name)], { windowsHide: true })
    const archive = await fs.readFile(zip)
    const volumes = [archive.subarray(0, 101), archive.subarray(101)]
    const volumeFiles = [path.join(dir, '1.zip.001'), path.join(dir, '1.zip.002')]
    for (const [index, bytes] of volumes.entries()) await fs.writeFile(volumeFiles[index], bytes)
    const native = path.join(out, 'native', 'KevinArchive.exe')
    const measure = execFileSync(native, ['measure', source], {
      windowsHide: true, input: volumeFiles.join('\n') + '\n', encoding: 'utf8'
    })
    assert.equal(Number(measure.trim()), files.reduce((sum, [_name, content]) => sum + content.length, 0))

    let reads = 0
    server.on('request', (request, response) => {
      reads++
      const index = request.url === '/patch.zip.001' ? 0 : 1
      const bytes = volumes[index]
      response.writeHead(200, { 'content-length': bytes.length })
      response.end(bytes)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const host = 'http://127.0.0.1:' + server.address().port
    const parts = volumes.map((bytes, index) => {
      const name = 'patch.zip.00' + (index + 1)
      return { name, size: bytes.length, md5: digest(bytes), url: host + '/' + name }
    }).reverse()
    const first = await runWorker(worker, {
      type: 'start', gameDir: game, targetVersion: '1.2.4', hpatchzPath: '<unused>',
      patch: { parts, infoMd5: digest(manifest), size: archive.length }
    })
    assert.equal(first.type, 'error')
    assert.equal(await fs.readFile(path.join(game, 'a.bin'), 'utf8'), 'new A', first.message)
    assert.deepEqual(await fs.readFile(path.join(game, 'config.ini')), oldMarker)
    await fs.access(path.join(game, '_kl_stage', 'commit.json'))
    await assert.rejects(fs.access(path.join(game, '_kl_delta')))
    await fs.rmdir(path.join(game, 'b.bin'))
    let cancelled = false
    const interrupted = await runWorker(worker, { type: 'recover', gameDir: game }, (value, owner) => {
      if (value.type === 'extracting' && !cancelled) {
        cancelled = true
        owner.postMessage({ type: 'cancel' })
      }
    })
    assert.equal(interrupted.type, 'error')
    assert.deepEqual(await fs.readFile(path.join(game, 'config.ini')), oldMarker)
    const recovery = await runWorker(worker, { type: 'recover', gameDir: game })
    assert.equal(recovery.type, 'done')
    assert.equal(await fs.readFile(path.join(game, 'b.bin'), 'utf8'), 'new B')
    assert.deepEqual(await fs.readFile(path.join(game, 'config.ini')), newMarker)
    assert.equal(await fs.readFile(path.join(game, 'third-party.tmp'), 'utf8'), 'keep')
    await assert.rejects(fs.access(path.join(game, '_kl_stage')))
    await assert.rejects(fs.access(path.join(game, 'old.bin')))
    assert.deepEqual(await fs.readdir(path.join(game, '_kl_packages')), [])
    assert.equal(reads, 2)
    console.log(JSON.stringify({ archiveMeasure: true, reads, gameDirectoryHasUnicode: true,
      interruptedCommit: true, recoveryCancellation: true, recoveredWithoutDownload: true,
      workerExitedBeforeReadingResult: true }))
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1 })
