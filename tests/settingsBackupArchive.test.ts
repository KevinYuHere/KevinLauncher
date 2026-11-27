import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { extractSettingsArchive, inspectSettingsArchive } from '../src/main/services/settingsBackupArchive'

interface Entry {
  name: string
  data?: Buffer
  /** Override the central-directory size without allocating that many bytes. */
  declaredSize?: number
}

/** Minimal stored-entry ZIP writer for offline archive-boundary tests. */
function archive(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data ?? Buffer.alloc(0)
    const checksum = crc32(data)
    const flags = /[^\x00-\x7f]/.test(entry.name) ? 0x800 : 0
    const local = Buffer.alloc(30 + name.length + data.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    data.copy(local, 30 + name.length)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(entry.declaredSize ?? data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)

    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

let root: string
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'kl-archive-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

async function written(entries: Entry[]): Promise<string> {
  const path = join(root, 'backup.zip')
  await fs.writeFile(path, archive(entries))
  return path
}

describe('settings archive preflight', () => {
  it('extracts owned files with Unicode names and ignores unrelated safe entries', async () => {
    const config = Buffer.from(JSON.stringify({ version: 14, apps: [] }))
    const media = Buffer.from('wallpaper bytes')
    const zip = await written([
      { name: 'config.json', data: config },
      { name: 'bg/旧版 壁纸.png', data: media },
      { name: 'Cache/ignored.bin', data: Buffer.from('cache') }
    ])
    const plan = await inspectSettingsArchive(zip)
    expect(plan.files).toEqual(['config.json', 'bg/旧版 壁纸.png'])
    expect(plan.expandedBytes).toBe(config.length + media.length + 5)

    const out = join(root, 'out')
    await extractSettingsArchive(zip, out, plan)
    expect(await fs.readFile(join(out, 'config.json'))).toEqual(config)
    expect(await fs.readFile(join(out, 'bg', '旧版 壁纸.png'))).toEqual(media)
    await expect(fs.access(join(out, 'Cache'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('extracts appearance presets as an owned root file', async () => {
    const config = Buffer.from(JSON.stringify({ version: 14, apps: [] }))
    const presets = Buffer.from(JSON.stringify({
      version: 1,
      presets: [{
        id: 'preset-1',
        name: '夜航',
        createdAt: '2026-11-26T08:00:00.000Z',
        updatedAt: '2026-11-26T08:00:00.000Z',
        areas: {},
        apps: {}
      }]
    }))
    const zip = await written([
      { name: 'config.json', data: config },
      { name: 'appearance-presets.json', data: presets }
    ])
    const plan = await inspectSettingsArchive(zip)
    expect(plan.files).toEqual(['config.json', 'appearance-presets.json'])
    const out = join(root, 'out')
    await extractSettingsArchive(zip, out, plan)
    expect(await fs.readFile(join(out, 'appearance-presets.json'))).toEqual(presets)
  })

  it('rejects a traversal name before writing anything', async () => {
    const zip = await written([
      { name: 'config.json', data: Buffer.from('{"version":14,"apps":[]}') },
      { name: '../outside.txt', data: Buffer.from('outside') }
    ])
    await expect(inspectSettingsArchive(zip)).rejects.toThrow('无效路径')
    await expect(fs.access(join(root, 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects declared expansion beyond the limit', async () => {
    const zip = await written([
      { name: 'config.json', data: Buffer.from('{}'), declaredSize: 0xfffffffe },
      { name: 'playtime.json', data: Buffer.from('{}'), declaredSize: 4 }
    ])
    await expect(inspectSettingsArchive(zip)).rejects.toThrow('总大小')
  })
})
