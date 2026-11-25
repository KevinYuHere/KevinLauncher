import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'http'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { GAME_BIZ, downloadMode, getGameConfig, getGameChannelSDK, getHoYoUpdateInfo, getGameDeprecatedFiles, getWPFPackage, type BranchPackage } from '../src/main/update/hoyoplay'
import { getSophonPlan } from '../src/main/update/sophonPlan'
import { UpdateManager } from '../src/main/update/updateManager'
import { hoyoPortBudget, withHoYoNetwork } from '../src/main/update/hoyoNetwork'
import { moveCachedResources, preparePackageVerification } from '../src/main/update/hoyoPackages'
import { gameWorkKey } from '../src/main/update/hoyoTemp'
import { openSophonCacheOwnership } from '../src/main/update/sophonCacheOwnership'

let userData: string
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => userData, getVersion: () => '2.0.5-beta.2' }
}))
vi.mock('../src/main/services/logger', () => ({ log: vi.fn() }))
vi.mock('../src/main/workers/sophonWorker?modulePath', () => ({ default: 'sophon' }))
vi.mock('../src/main/workers/arknightsWorker?modulePath', () => ({ default: 'arknights' }))

const ids = { genshin: '1Z8W5NHUQb', starrail: '64kMb5iAWu', zzz: 'x6znKlJ0xK' }
const record = (game: keyof typeof ids) => ({ id: ids[game], biz: GAME_BIZ[game] })
const envelope = (data: unknown) => Response.json({ retcode: 0, data })
const main: BranchPackage = { packageId: 'main-id', branch: 'main', password: 'pw', tag: '2.0', categories: [], diffTags: [] }
const pre: BranchPackage = { ...main, packageId: 'pre-id', branch: 'pre', tag: '3.0', diffTags: ['1.0'] }
const signal = new AbortController().signal
const clean: (() => Promise<unknown>)[] = []
const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex')
beforeEach(() => {
  // The fixture takes a non-default loopback port. Simulate an exhausted
  // resend window so these tests can focus on stage and asset ordering.
  Atomics.store(new BigUint64Array(hoyoPortBudget), 0, (BigInt(Date.now() + 1_800_000) << 4n) + 10n)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const action of clean.splice(0).reverse()) await action()
})

it('releases the parsed FILE manifest and reloads its own snapshot without network', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'kl-file-park-'))
  clean.push(() => fs.rm(root, { recursive: true, force: true }))
  const dir = await fs.realpath(root)
  const contents = JSON.stringify({ remoteName: 'file.bin', fileSize: 4, md5: md5(Buffer.from('data')) })
  const fetch = vi.fn(async () => new Response(contents))
  vi.stubGlobal('fetch', fetch)
  const prefix = 'https://fixture.invalid/release'
  const work = gameWorkKey('starrail', '1.0', '2.0', 'update')
  const verification = await preparePackageVerification(dir, prefix, [], signal, work)
  const before = await verification.load(signal)
  expect(before).toMatchObject([{ name: 'file.bin', size: 4 }])
  verification.park()
  await fs.writeFile(join(dir, 'pkg_version'), 'a different live manifest')
  const after = await verification.load(signal)
  expect(after).toEqual(before)
  expect(after).not.toBe(before)
  expect(fetch).toHaveBeenCalledOnce()
})

it('does not move a cached asset through a redirected game subdirectory', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'kl-hoyo-alias-'))
  clean.push(() => fs.rm(root, { recursive: true, force: true }))
  const dir = join(await fs.realpath(root), 'game')
  const source = join(dir, 'cache')
  const outside = join(await fs.realpath(root), 'outside')
  await Promise.all([fs.mkdir(source, { recursive: true }), fs.mkdir(outside)])
  await fs.writeFile(join(source, 'keep.bin'), 'cache data')
  const redirected = join(dir, 'audio')
  try {
    await fs.symlink(outside, redirected, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    const realpath = fs.realpath.bind(fs)
    vi.spyOn(fs, 'realpath').mockImplementation(path => path === redirected ? Promise.resolve(outside) : realpath(path))
  }
  await expect(moveCachedResources(dir, { audioCacheDir: 'cache', audioResDir: 'audio' } as Parameters<typeof moveCachedResources>[1], signal))
    .rejects.toThrow(/重解析点/)
  expect(await fs.readFile(join(source, 'keep.bin'), 'utf8')).toBe('cache data')
  expect(await fs.readdir(outside)).toEqual([])
})

it('retains shared cache files and replacements with a different file identity', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'kl-cache-ownership-'))
  clean.push(() => fs.rm(root, { recursive: true, force: true }))
  const dir = await fs.realpath(root)
  await fs.mkdir(join(dir, 'chunk'))
  const shared = join(dir, 'chunk', 'shared'), changed = join(dir, 'chunk', 'replaced')
  await Promise.all([fs.writeFile(shared, 'shared bytes'), fs.writeFile(changed, 'original bytes')])
  const oldTarget = gameWorkKey('genshin', '1.0', '2.0', 'sophon-cache')
  const newTarget = gameWorkKey('genshin', '1.0', '3.0', 'sophon-cache')
  const original = await openSophonCacheOwnership(dir, oldTarget)
  await original.record(shared, true)
  await original.record(changed, true)
  await original.save()
  const second = await openSophonCacheOwnership(dir, newTarget)
  await second.record(shared, false)
  await second.save()
  await fs.rename(changed, changed + '.old')
  await fs.writeFile(changed, 'new file at the same path')
  const cleanup = await openSophonCacheOwnership(dir, oldTarget)
  await cleanup.release()
  await cleanup.save()
  expect(await fs.readFile(shared, 'utf8')).toBe('shared bytes')
  expect(await fs.readFile(changed, 'utf8')).toBe('new file at the same path')
  const nextCleanup = await openSophonCacheOwnership(dir, newTarget)
  await nextCleanup.release()
  await expect(fs.stat(shared)).rejects.toMatchObject({ code: 'ENOENT' })
})

describe('Starward 0.19.0 update preparation', () => {
  it.each([true, false])('selects patch solely by DiffTags; advertised=%s', async hit => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: URL | string) => {
      const url = new URL(input)
      const method = url.pathname.split('/').pop()!
      calls.push([method, url.searchParams.get('branch'), url.searchParams.get('tag')].filter(Boolean).join('/'))
      return envelope({ build_id: 'id', patch_id: 'p', tag: '3.0', manifests: [] })
    })
    const plan = await getSophonPlan(main, { ...pre, diffTags: hit ? ['1.0'] : [] }, '1.0', signal)
    expect(plan.kind).toBe(hit ? 'patch' : 'chunk')
    expect(calls).toEqual(hit ? ['getBuild/main', 'getPatchBuild/pre'] : ['getBuild/main', 'getBuild/main/1.0', 'getBuild/pre'])
  })
  it('stops a missing advertised patch without fetching the target chunk', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: string) => {
      const name = new URL(input).pathname.split('/').pop()!
      calls.push(name)
      return name === 'getBuild' ? envelope({ manifests: [] }) : Response.json({ retcode: -202, message: 'missing' })
    })
    await expect(getSophonPlan(main, pre, '1.0', signal)).rejects.toThrow(/重试/)
    expect(calls).toEqual(['getBuild', 'getPatchBuild'])
  })
  it('uses each game’s advertised mode, including Star Rail FILE', async () => {
    vi.stubGlobal('fetch', async () => envelope({ launch_configs: Object.keys(ids).map(key => ({
      game: record(key as keyof typeof ids), default_download_mode: key === 'starrail' ? 'DOWNLOAD_MODE_FILE' : 'DOWNLOAD_MODE_CHUNK'
    })) }))
    expect(await Promise.all((Object.keys(ids) as (keyof typeof ids)[]).map(async key => downloadMode(await getGameConfig(key))))).toEqual(['chunk', 'package', 'chunk'])
  })
  it.each([getGameChannelSDK, getWPFPackage, getGameDeprecatedFiles])('separates HTTP and retcode errors from valid empty metadata', async get => {
    vi.stubGlobal('fetch', async () => Response.json({ retcode: 0, data: {} }, { status: 503 }))
    await expect(get('genshin')).rejects.toThrow(/503/)
    vi.stubGlobal('fetch', async () => Response.json({ retcode: 13, message: 'denied', data: {} }))
    await expect(get('genshin')).rejects.toThrow(/denied/)
    vi.stubGlobal('fetch', async () => envelope({ game_channel_sdks: [], wpf_packages: [], deprecated_file_configs: [] }))
    expect(await get('genshin')).toEqual(get === getGameDeprecatedFiles ? [] : null)
  })
})

it.each(['ok', 'current', 'bad-sdk', 'resume-sdk', 'repair-corrupt', 'repair-failed', 'archive-corrupt'] as const)('keeps compressed predownload and component completion consistent (%s)', async scenario => {
  const root = await fs.mkdtemp(join(tmpdir(), 'kl-hoyo-'))
  clean.push(() => fs.rm(root, { recursive: true, force: true }))
  userData = join(root, 'user-data')
  const dir = join(root, 'game'), src = join(root, 'archives')
  await Promise.all([fs.mkdir(dir), fs.mkdir(src)])
  await fs.writeFile(join(dir, 'config.ini'), '[General]\ngame_version=1.0\ncps=user\ncustom=keep\nsdk_version=' + (scenario === 'current' ? '5' : '1') + '\nwpf_version=' + (scenario === 'current' ? '7' : '1'))
  const bodies = new Map<string, Buffer>()
  const repair = scenario === 'repair-corrupt' || scenario === 'repair-failed'
  for (const [file, value] of [['game.bin', repair ? 'altered' : 'updated'], ['sdk.bin', 'sdk'], ['wpf.bin', 'wpf']]) {
    await fs.writeFile(join(src, file), value)
    execFileSync('tar', ['-acf', join(src, file + '.zip'), '-C', src, file], { windowsHide: true })
    bodies.set(file + '.zip', await fs.readFile(join(src, file + '.zip')))
  }
  if (scenario === 'ok') {
    const patch = Buffer.concat([Buffer.from('HDIFF13&\0'), Buffer.from([7, 3, 0, 0, 0, 1, 0, 0, 0, 7, 0, 6]), Buffer.from('changed')])
    await fs.writeFile(join(src, 'hdifffiles.txt'), [null, { remoteName: 'base' }, { remoteName: 'lost' }].map(row => JSON.stringify(row)).join('\n'))
    await fs.writeFile(join(src, 'hdiffmap.json'), JSON.stringify({ diff_map: [{ source_file_name: 'old', patch_file_name: 'map.diff', target_file_name: 'new' }] }))
    for (const name of ['base.hdiff', 'map.diff', 'lost.hdiff']) await fs.writeFile(join(src, name), patch)
    for (const name of ['old', 'base']) await fs.writeFile(join(dir, name), 'old')
    const filter = join(dir, 'nested', 'flags.bin')
    await fs.mkdir(join(dir, 'nested'))
    await fs.writeFile(filter, 'persistent')
    if (process.platform === 'win32') execFileSync('attrib.exe', ['+R', '+H', '+S', filter], { windowsHide: true })
    await fs.writeFile(join(dir, 'unrelated.tmp'), 'keep this file')
    await fs.writeFile(join(dir, 'nested', 'unrelated_tmp'), 'keep this file too')
    execFileSync('tar', ['-acf', join(src, 'game.bin.zip'), '-C', src, 'game.bin', 'hdifffiles.txt', 'hdiffmap.json', 'base.hdiff', 'lost.hdiff', 'map.diff'], { windowsHide: true })
    bodies.set('game.bin.zip', await fs.readFile(join(src, 'game.bin.zip')))
  }
  const gameBytes = Buffer.from('updated'), sdkBytes = Buffer.from('sdk')
  if (scenario === 'repair-corrupt') bodies.set('game.bin', gameBytes)
  const expectedFiles = [{ remoteName: 'game.bin', fileSize: gameBytes.length, md5: md5(gameBytes) }]
  if (scenario === 'ok') {
    for (const name of ['base', 'new']) expectedFiles.push({ remoteName: name, fileSize: 7, md5: md5(Buffer.from('changed')) })
  }
  bodies.set('pkg_version', Buffer.from(expectedFiles.map(file => JSON.stringify(file)).join('\n')))
  if (scenario === 'current') {
    await fs.writeFile(join(dir, 'sdk.bin'), sdkBytes)
    await fs.writeFile(join(dir, 'sdk_version_list'), JSON.stringify({ remoteName: 'sdk.bin', fileSize: '3', md5: md5(sdkBytes) }))
  }
  const requests: string[] = []
  let sdkUnavailable = scenario === 'resume-sdk'
  const server = createServer((req, res) => {
    const name = req.url!.slice(1)
    requests.push(name)
    if (sdkUnavailable && name === 'sdk.bin.zip') { res.writeHead(503).end(); return }
    const body = bodies.get(name)
    if (!body) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Length': body.length }).end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  clean.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const pkg = (name: string) => ({ url: url + '/' + name, size: String(bodies.get(name)!.length), md5: md5(bodies.get(name)!) })
  const gamePkg = pkg('game.bin.zip')
  const resources = {
    major: { version: '2.0', res_list_url: url, game_pkgs: [{ ...gamePkg, url: url + '/unused-major.zip' }] },
    patches: [{ version: '1.0', game_pkgs: [gamePkg] }]
  }
  if (scenario === 'bad-sdk') {
    // Correct archive hash, invalid ZIP: extraction fails after WPF has succeeded.
    bodies.set('sdk.bin.zip', Buffer.from('not an archive'))
  }
  const original = fetch
  let promoted = false
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit) => {
    const u = new URL(input)
    if (u.hostname === '127.0.0.1') return original(input, init)
    const name = u.pathname.split('/').pop()!
    calls.push(name)
    const game = record('starrail')
    const endpoints: Record<string, unknown> = {
      getGames: { games: [game] },
      getGameConfigs: { launch_configs: [{ game, default_download_mode: 'DOWNLOAD_MODE_FILE' }] },
      getGamePackages: { game_packages: [{ game, main: promoted ? resources : { ...resources, major: { ...resources.major, version: '1.0' } }, pre_download: resources }] },
      getWPFPackages: { wpf_packages: [{ game, wpf_package: { version: '7', ...pkg('wpf.bin.zip') } }] },
      getGameChannelSDKs: { game_channel_sdks: [{ game, version: '5', pkg_version_file_name: 'sdk_version_list', channel_sdk_pkg: pkg('sdk.bin.zip') }] },
      getGamePlugins: { plugin_releases: [{ game, plugins: [
        { plugin_id: 'dx', version: '8', plugin_pkg: { ...pkg('wpf.bin.zip'), url: url + '/DXSETUP.zip' } },
        { plugin_id: 'current', version: '3', plugin_pkg: { ...pkg('wpf.bin.zip'), validation: JSON.stringify([{ path: 'game.bin', md5: md5(gameBytes) }]) } },
        { plugin_id: 'invalid', version: '4', plugin_pkg: { ...pkg('wpf.bin.zip'), validation: 'invalid json' } }
      ] }] },
      getGameDeprecatedFileConfigs: { deprecated_file_configs: [] }
    }
    return envelope(endpoints[name])
  })
  const manager = new UpdateManager()
  await manager.start('s', 'preDownload', 'starrail', dir)
  expect(manager.status('s')).toMatchObject({ phase: 'done' })
  expect(await fs.readFile(join(dir, 'config.ini'), 'utf8')).toContain('predownload=1.0,2.0,None')
  expect((await getHoYoUpdateInfo('starrail', dir)).preDownloadFinished).toBe(true)
  expect(requests).toEqual(['game.bin.zip'])
  expect(calls).not.toContain('getWPFPackages')
  if (scenario === 'archive-corrupt') {
    const archive = join(dir, 'game.bin.zip')
    await fs.writeFile(archive, Buffer.alloc((await fs.stat(archive)).size, 1))
  }
  promoted = true
  const now = Date.now
  vi.spyOn(Date, 'now').mockImplementation(() => now() + 6 * 60_000)

  const next = new UpdateManager()
  await next.start('s', 'update', 'starrail', dir)
  if (scenario === 'resume-sdk') {
    expect(next.status('s').phase).toBe('error')
    expect(await fs.readFile(join(dir, 'wpf.bin'), 'utf8')).toBe('wpf')
    expect(await fs.readFile(join(dir, 'config.ini'), 'utf8')).toContain('game_version=1.0')
    const before = [...requests]
    sdkUnavailable = false
    await next.start('s', 'update', 'starrail', dir)
    expect(requests).toEqual([...before, 'sdk.bin.zip'])
    expect(await fs.readFile(join(dir, 'sdk.bin'), 'utf8')).toBe('sdk')
  }
  const ini = await fs.readFile(join(dir, 'config.ini'), 'utf8')
  if (scenario === 'bad-sdk' || scenario === 'repair-failed') {
    expect(next.status('s').phase).toBe('error')
    expect(ini).toContain('game_version=1.0')
    expect(ini).toContain('wpf_version=1')
    if (scenario === 'repair-failed') expect(await fs.readFile(join(dir, 'game.bin'), 'utf8')).toBe('altered')
  } else {
    expect(next.status('s')).toMatchObject({ phase: 'done' })
    expect(ini).toContain('game_version=2.0')
    expect(ini).toContain('sdk_version=5')
    expect(ini).toContain('wpf_version=7')
    expect(ini).not.toContain('predownload=')
    expect(ini).toContain('custom=keep')
    expect(ini).toContain('plugin_current_version=3')
    expect(ini).not.toContain('plugin_invalid_version')
    expect(ini).not.toContain('plugin_dx_version')
    expect(await fs.readFile(join(dir, 'game.bin'), 'utf8')).toBe('updated')
    if (scenario === 'ok') {
      expect(await fs.readFile(join(dir, 'wpf.bin'), 'utf8')).toBe('wpf')
      for (const name of ['base', 'new']) expect(await fs.readFile(join(dir, name), 'utf8')).toBe('changed')
      const names = await fs.readdir(dir)
      expect(await fs.readFile(join(dir, 'unrelated.tmp'), 'utf8')).toBe('keep this file')
      expect(await fs.readFile(join(dir, 'nested', 'unrelated_tmp'), 'utf8')).toBe('keep this file too')
      for (const name of ['old', 'base.hdiff', 'lost.hdiff', 'map.diff', 'hdifffiles.txt', 'hdiffmap.json']) expect(names).not.toContain(name)
      if (process.platform === 'win32') {
        const flags = execFileSync('attrib.exe', [join(dir, 'nested', 'flags.bin')], { encoding: 'utf8', windowsHide: true })
        expect(flags.split(dir)[0]).toMatch(/R/)
        expect(flags.split(dir)[0]).toMatch(/H/)
        expect(flags.split(dir)[0]).toMatch(/S/)
        execFileSync('attrib.exe', ['-R', '-H', '-S', join(dir, 'nested', 'flags.bin')], { windowsHide: true })
      }
    }
  }
  const expectedRequests = ['game.bin.zip', 'pkg_version']
  if (scenario === 'archive-corrupt') expectedRequests.push('game.bin.zip')
  if (repair) expectedRequests.push(...Array(scenario === 'repair-failed' ? 3 : 1).fill('game.bin'))
  if (scenario !== 'current' && scenario !== 'repair-failed') expectedRequests.push('wpf.bin.zip', 'sdk.bin.zip')
  if (scenario === 'resume-sdk') expectedRequests.push('sdk.bin.zip', 'sdk.bin.zip', 'sdk.bin.zip')
  expect(requests).toEqual(expectedRequests)
}, 15_000)

it('rejects a known wrong game, wrong region or channel before contacting HoYoPlay', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'kl-hoyo-preflight-'))
  clean.push(() => fs.rm(dir, { recursive: true, force: true }))
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  for (const extra of ['game_biz=hk4e_cn', 'game_biz=hkrpg_global', 'channel=14']) {
    await fs.writeFile(join(dir, 'config.ini'), 'game_version=1.2.3\n' + extra)
    const info = await getHoYoUpdateInfo('starrail', dir)
    expect(info.supported).toBe(false)
  }
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps the original Sophon file when an applied patch fails target validation', async () => {
  const { runSophonPatch } = await import('../src/main/update/sophonPatch')
  const dir = await fs.mkdtemp(join(tmpdir(), 'kl-ldiff-bad-output-'))
  clean.push(() => fs.rm(dir, { recursive: true, force: true }))
  const source = Buffer.from('old')
  const blob = Buffer.concat([Buffer.from('HDIFF13&\0'), Buffer.from([7, 3, 0, 0, 0, 1, 0, 0, 0, 7, 0, 6]), Buffer.from('changed')])
  await fs.mkdir(join(dir, 'ldiff'))
  await fs.writeFile(join(dir, 'base.bin'), source)
  await fs.writeFile(join(dir, 'ldiff', 'blob'), blob)
  const category = {
    categoryId: 'game', matchingField: 'game', manifestId: 'safe', manifestUrlPrefix: '',
    manifestCompression: 0, manifestSuffix: '', diffUrlPrefix: '', diffCompression: 0, diffSuffix: '', versions: {}
  }
  const chunk = {
    patchName: 'blob', patchFileSize: blob.length, patchFileMd5: md5(blob), patchOffset: 0, patchLength: blob.length,
    originalFileName: 'base.bin', originalFileLength: source.length, originalFileMd5: md5(source)
  }
  const asset = { assetName: 'target.bin', size: 7, md5: md5(Buffer.from('valid!!')), infos: [] }
  await runSophonPatch({ patchId: 'patch', tag: '2.0', categories: [category] }, '1.0', dir, false,
    join(process.cwd(), 'resources', 'hpatchz.exe'), [], () => {}, signal, undefined,
    { tasks: [{ category, chunk, asset, mode: 0 }], deletes: [] })
  expect(await fs.readFile(join(dir, 'base.bin'), 'utf8')).toBe('old')
  await expect(fs.access(join(dir, 'target.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
})


it.each(['cached', 'range', 'resume'])('applies a real patch manifest using %s', async mode => {
  const { runSophonPatch } = await import('../src/main/update/sophonPatch')
  const dir = await fs.mkdtemp(join(tmpdir(), 'kl-hoyo-patch-'))
  clean.push(() => fs.rm(dir, { recursive: true, force: true }))
  const bytes = Buffer.from('live'), blob = Buffer.from('00live00')
  function uint(value: number): Buffer {
    const out: number[] = []
    while (value > 127) { out.push((value & 127) | 128); value >>>= 7 }
    return Buffer.from([...out, value])
  }
  const num = (key: number, n: number) => Buffer.concat([uint(key * 8), uint(n)])
  const field = (key: number, data: Buffer | string) => {
    const value = Buffer.from(data)
    return Buffer.concat([uint(key * 8 + 2), uint(value.length), value])
  }
  const diff = Buffer.concat([field(1, 'blob'), num(4, blob.length), field(5, md5(blob)), num(6, 2), num(7, 4)])
  const change = Buffer.concat([field(1, '1.0'), field(2, diff)])
  const file = Buffer.concat([field(1, 'content.bin'), num(2, 4), field(3, md5(bytes)), field(4, change)])
  const manifest = Buffer.concat([field(1, file), num(3, 1)])
  const ranges: (string | undefined)[] = []
  let manifestRequests = 0
  const server = createServer((req, res) => {
    if (req.url === '/manifest') { manifestRequests++; res.end(manifest); return }
    if (req.url !== '/blob') { res.writeHead(404).end(); return }
    ranges.push(req.headers.range)
    if (req.headers.range) {
      const first = Number(req.headers.range.match(/^bytes=(\d+)-/)![1])
      res.writeHead(206, { 'Content-Range': 'bytes ' + first + '-5/8' }).end(blob.subarray(first, 6))
      return
    }
    res.end(blob)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  clean.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const build = { tag: '2.0', patchId: 'id', categories: [{
    categoryId: '1', matchingField: 'game', manifestId: 'manifest', manifestMd5: md5(manifest),
    manifestSize: manifest.length, manifestCompression: 0,
    manifestUrlPrefix: url, manifestSuffix: '', diffCompression: 0, diffUrlPrefix: url, diffSuffix: '', versions: {}
  }] }
  if (mode === 'resume') {
    await fs.mkdir(join(dir, 'ldiff'))
    await fs.writeFile(join(dir, 'ldiff', 'blob_2'), bytes.subarray(0, 2))
  }
  if (mode === 'cached') {
    await withHoYoNetwork(join(dir, 'user-data'), 'runner',
      () => runSophonPatch(build, '1.0', dir, true, '', [], () => {}, signal))
    await expect(fs.stat(join(dir, 'content.bin'))).rejects.toThrow()
    expect(await fs.readFile(join(dir, 'ldiff', 'blob'))).toEqual(blob)
  }
  await withHoYoNetwork(join(dir, 'user-data'), 'runner',
    () => runSophonPatch(build, '1.0', dir, false, '', [], () => {}, signal))
  expect(await fs.readFile(join(dir, 'content.bin'))).toEqual(bytes)
  expect(ranges).toEqual(mode === 'cached' ? [undefined] : mode === 'resume' ? ['bytes=4-5'] : ['bytes=2-5'])
  expect(manifestRequests).toBe(1)
})
