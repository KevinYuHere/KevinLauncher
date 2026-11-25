// Runs before the versioned app and stays in place across hot updates.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const activationFile = 'app-activation.json'
const identityKey = Symbol.for('kevin-launcher.loaded-application')
const maxAttempts = 2
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/
const isVersion = value => typeof value === 'string' && value.length <= 96 && versionPattern.test(value)

function readActivation(resources) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(resources, activationFile), 'utf8'))
    if (!raw || raw.schema !== 1 ||
        ['healthy', 'previousHealthy', 'rejected'].some(key => raw[key] != null && !isVersion(raw[key])) ||
        raw.pending && (!isVersion(raw.pending.target) || !isVersion(raw.pending.previous) ||
          raw.pending.target === raw.pending.previous ||
          !Number.isSafeInteger(raw.pending.attempts) || raw.pending.attempts < 0 ||
          raw.pending.pid != null && (!Number.isSafeInteger(raw.pending.pid) || raw.pending.pid < 1))) {
      throw new Error('更新激活记录损坏')
    }
    return raw
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1 }
    return null
  }
}

function writeAtomic(resources, file, contents) {
  const target = path.join(resources, file)
  const temporary = target + '.' + randomUUID() + '.tmp'
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx' })
    fs.renameSync(temporary, target)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function readPointer(resources) {
  try {
    const value = fs.readFileSync(path.join(resources, 'app-version.txt'), 'utf8').trim()
    return isVersion(value) ? value : undefined
  } catch {
    return undefined
  }
}

function getEntry(resources, version) {
  if (!isVersion(version)) return undefined
  const directory = path.join(resources, 'app-' + version)
  const main = path.join(directory, 'out', 'main', 'index.js')
  try {
    if (!fs.lstatSync(directory).isDirectory() || !fs.lstatSync(main).isFile()) return undefined
    if (fs.realpathSync(directory).toLowerCase() !== directory.toLowerCase() ||
        fs.realpathSync(main).toLowerCase() !== main.toLowerCase()) return undefined
    const info = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    if (info.version !== version) return undefined
    return { version, directory, main }
  } catch {
    return undefined
  }
}

function compare(left, right) {
  const [a, ...preA] = left.split('-')
  const [b, ...preB] = right.split('-')
  const numbers = a.split('.').map(Number)
  const other = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (numbers[i] !== other[i]) return numbers[i] - other[i]
  if (!preA.length || !preB.length) return preB.length - preA.length
  return preA.join('-').localeCompare(preB.join('-'), 'en', { numeric: true })
}

function ownerRunning(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

function recordStartupAttempt(resources, version) {
  const state = readActivation(resources)
  const pending = state?.pending
  if (pending?.target !== version || readPointer(resources) !== version) {
    throw new Error('加载应用后更新激活记录发生变化')
  }
  if (pending.pid === process.pid) return
  writeAtomic(resources, activationFile, JSON.stringify({
    ...state, pending: { ...pending, attempts: pending.attempts + 1, pid: process.pid }
  }))
}

function selectApp(resources) {
  resources = fs.realpathSync(resources)
  let pointer = readPointer(resources)
  const state = readActivation(resources)
  const pending = state?.pending
  if (pending && pointer === pending.target) {
    const candidate = getEntry(resources, pending.target)
    if (candidate && (pending.attempts < maxAttempts || ownerRunning(pending.pid))) {
      // The primary main process records the attempt after taking Electron's
      // single-instance lock. Concurrent secondary launches are read-only.
      return { ...candidate, pending: true }
    }
    const previous = getEntry(resources, pending.previous)
    if (!previous) throw new Error('新版启动失败，且无法读取上一健康版本')
    // Mark rejection first so a crash before repairing the pointer never
    // starts the failed target again.
    writeAtomic(resources, activationFile, JSON.stringify({
      schema: 1, healthy: pending.previous, rejected: pending.target
    }))
    writeAtomic(resources, 'app-version.txt', pending.previous)
    pointer = pending.previous
  }

  const preferred = [pointer, state?.healthy, state?.previousHealthy].filter(Boolean)
  const excluded = new Set([state?.rejected, pending?.target])
  const installed = fs.readdirSync(resources, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('app-'))
    .map(entry => entry.name.slice(4)).filter(isVersion).sort((a, b) => compare(b, a))
  for (const version of [...preferred, ...installed]) {
    if (excluded.has(version)) continue
    const selected = getEntry(resources, version)
    if (selected) return { ...selected, pending: false }
  }
  throw new Error('找不到可用的 resources/app-<version> 应用代码')
}

function bootstrap() {
  const resources = process.resourcesPath
  const selected = selectApp(resources)
  Object.defineProperty(process, identityKey, {
    value: Object.freeze({
      version: selected.version, directory: selected.directory, pending: selected.pending,
      recordStartup: selected.pending ? () => recordStartupAttempt(resources, selected.version) : undefined
    })
  })
  try {
    require(selected.main)
  } catch (error) {
    // Failure while evaluating main happens before its single-instance lock.
    // Do not count another failure while an already admitted owner lives.
    if (selected.pending && !ownerRunning(readActivation(resources)?.pending?.pid)) {
      try { recordStartupAttempt(resources, selected.version) } catch { /* retain the original error */ }
    }
    throw error
  }
}

module.exports = { bootstrap, selectApp, recordStartupAttempt }
