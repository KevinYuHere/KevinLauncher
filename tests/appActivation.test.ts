import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, expect, test } from 'vitest'
import { recordStartupAttempt, selectApp } from '../shell/loader.js'
import { isHotUpdateCompatible } from '../src/main/services/appUpdateManifest'
import { requireDiskSpace } from '../src/main/services/diskSpace'

const roots: string[] = []

async function fixture(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'kl-loader-test-'))
  roots.push(directory)
  return fs.realpath(directory)
}

async function installApp(directory: string, version: string): Promise<void> {
  const root = join(directory, `app-${version}`)
  await fs.mkdir(join(root, 'out', 'main'), { recursive: true })
  await fs.writeFile(join(root, 'package.json'), JSON.stringify({ version }))
  await fs.writeFile(join(root, 'out', 'main', 'index.js'), '')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
})

test('falls back to the known healthy version and ignores a malformed pointer', async () => {
  const root = await fixture()
  await installApp(root, '2.0.5')
  await installApp(root, '2.0.6')
  await fs.writeFile(join(root, 'app-version.txt'), '../outside')
  await fs.writeFile(join(root, 'app-activation.json'), JSON.stringify({ schema: 1, healthy: '2.0.5' }))
  expect(selectApp(root)).toMatchObject({ version: '2.0.5', directory: join(root, 'app-2.0.5'), pending: false })
})

test('preserves both candidates through bounded startup attempts and then rolls back', async () => {
  const root = await fixture()
  await installApp(root, '2.0.5')
  await installApp(root, '2.0.6')
  const pointer = join(root, 'app-version.txt')
  const activation = join(root, 'app-activation.json')
  await fs.writeFile(pointer, '2.0.6')
  await fs.writeFile(activation, JSON.stringify({
    schema: 1, healthy: '2.0.5', pending: { target: '2.0.6', previous: '2.0.5', attempts: 0 }
  }))
  expect(selectApp(root)).toMatchObject({ version: '2.0.6', pending: true })
  recordStartupAttempt(root, '2.0.6')
  expect(selectApp(root)).toMatchObject({ version: '2.0.6', pending: true })
  recordStartupAttempt(root, '2.0.6')
  let recorded = JSON.parse(await fs.readFile(activation, 'utf8'))
  expect(recorded.pending.attempts).toBe(1)
  delete recorded.pending.pid
  await fs.writeFile(activation, JSON.stringify(recorded))
  recordStartupAttempt(root, '2.0.6')
  // A duplicate launch during the second attempt still selects the same
  // target and will lose Electron's lock, so it never rolls back the owner.
  expect(selectApp(root)).toMatchObject({ version: '2.0.6', pending: true })
  recorded = JSON.parse(await fs.readFile(activation, 'utf8'))
  expect(recorded.pending.attempts).toBe(2)
  delete recorded.pending.pid
  await fs.writeFile(activation, JSON.stringify(recorded))
  expect(selectApp(root)).toMatchObject({ version: '2.0.5', pending: false })
  expect(await fs.readFile(pointer, 'utf8')).toBe('2.0.5')
  expect(JSON.parse(await fs.readFile(activation, 'utf8'))).toEqual({
    schema: 1, healthy: '2.0.5', rejected: '2.0.6'
  })
  expect(selectApp(root).version).toBe('2.0.5')
})

test('a hot update requires matching shell, installer, data and host resource metadata', () => {
  const host = { shellProtocol: 2, installProtocol: 1, dataSchema: 1, hostSha256: 'a'.repeat(64) }
  expect(isHotUpdateCompatible(host, host)).toBe(true)
  expect(isHotUpdateCompatible(host, undefined)).toBe(false)
  expect(isHotUpdateCompatible(host, { ...host, shellProtocol: 3 })).toBe(false)
  expect(isHotUpdateCompatible(host, { ...host, installProtocol: 2 })).toBe(false)
  expect(isHotUpdateCompatible(host, { ...host, dataSchema: 2 })).toBe(false)
  expect(isHotUpdateCompatible(host, { ...host, hostSha256: 'b'.repeat(64) })).toBe(false)
})

test('sums simultaneous data snapshot and extraction only on the same volume', async () => {
  const needs = [{ path: 'data', bytes: 80 }, { path: 'program', bytes: 70 }]
  await expect(requireDiskSpace(needs, async path => ({ id: path, available: 100n }))).resolves.toBeUndefined()
  await expect(requireDiskSpace(needs, async () => ({ id: 'same', available: 100n }))).rejects.toThrow('150 字节')
  await expect(requireDiskSpace(needs, async () => ({ id: 'same', available: 0n }))).rejects.toThrow('可用 0 字节')
  await expect(requireDiskSpace(needs, async () => { throw Error('volume unreachable') })).rejects.toThrow('无法确认')
})
