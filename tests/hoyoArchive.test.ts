import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extractHoYoArchive } from '../src/main/update/hoyoArchive'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe.skipIf(process.platform !== 'win32')('Windows game archive reader', () => {
  it.each(['zip', '7z'])('seeks across manifest-ordered %s volumes and preserves hardlink donors', async format => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'kl-archive-test-'))
    roots.push(dir)
    const content = randomBytes(175_000)
    const name = '游戏 资源.bin'
    await fs.writeFile(join(dir, name), content)
    const filename = 'stock.' + format
    execFileSync(resolve('node_modules/7zip-bin/win/x64/7za.exe'),
      ['a', '-t' + format, filename, name], { cwd: dir, windowsHide: true, stdio: 'pipe' })
    const compressed = await fs.readFile(join(dir, filename))
    const parts = [join(dir, '第三卷'), join(dir, '第一卷'), join(dir, '余下数据')]
    await Promise.all([
      fs.writeFile(parts[0], compressed.subarray(0, 13)),
      fs.writeFile(parts[1], compressed.subarray(13, 81_337)),
      fs.writeFile(parts[2], compressed.subarray(81_337))
    ])
    const destination = join(dir, '安装 路径')
    await fs.mkdir(destination)
    const donor = join(dir, '另一个游戏中的旧文件')
    await fs.writeFile(donor, 'before')
    await fs.link(donor, join(destination, name))
    await extractHoYoArchive(parts, destination, new AbortController().signal)
    expect(await fs.readFile(join(destination, name))).toEqual(content)
    expect(await fs.readFile(donor, 'utf8')).toBe('before')
    expect(await fs.readdir(destination)).toEqual([name])
    if (format === '7z') {
      await expect(extractHoYoArchive([join(dir, filename)], destination, new AbortController().signal, 'plugin'))
        .rejects.toThrow('解压')
    }
  })

  it('returns an archive error for a truncated file and honours cancellation', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'kl-archive-test-'))
    roots.push(dir)
    const path = join(dir, 'truncated.zip')
    await fs.writeFile(path, 'not a zip')
    await expect(extractHoYoArchive([path], dir, new AbortController().signal)).rejects.toThrow('解压')
    const controller = new AbortController()
    const task = extractHoYoArchive([path], dir, controller.signal)
    controller.abort()
    await expect(task).rejects.toThrow()
  })
})
