import { join } from 'path'
import {
  APPEARANCE_PRESET_FILE,
  APPEARANCE_PRESET_VERSION,
  normalizeAppearancePresetFile,
  summarizeAppearancePreset,
  type AppearancePreset,
  type AppearancePresetSummary
} from '@shared/appearancePreset'
import { DataError } from '@shared/dataErrors'
import { writeFileAtomic } from './atomicFile'
import { openJsonStore } from './jsonStore'

interface PresetFile {
  version: number
  presets: AppearancePreset[]
}

interface ReadResult {
  presets: AppearancePreset[]
  /** False when the on-disk file must not be rewritten (read/format problem). */
  writable: boolean
}

export interface AppearancePresetStore {
  list(): Promise<AppearancePresetSummary[]>
  get(id: string): Promise<AppearancePreset | null>
  remove(id: string): Promise<AppearancePresetSummary[]>
}

const byUpdated = (left: { updatedAt: string }, right: { updatedAt: string }): number =>
  right.updatedAt.localeCompare(left.updatedAt)

async function readStore(file: string): Promise<ReadResult> {
  const loaded = await openJsonStore<unknown>(
    file,
    () => ({ version: APPEARANCE_PRESET_VERSION, presets: [] }),
    'appearancePresets'
  )
  if (!loaded.writable) {
    throw new DataError('READ_FAILED', '外观预设读取失败，已暂停写入', loaded.error)
  }
  const normalized = normalizeAppearancePresetFile(loaded.data)
  if (!normalized) {
    throw new DataError('INVALID_CONFIG', '外观预设文件格式无效，已保留原文件')
  }
  // A file with one damaged entry stays untouched. Valid presets can still be
  // browsed and applied; removal is disabled until the file is repaired.
  return { presets: normalized.presets, writable: normalized.invalid === 0 }
}

/**
 * Atomic, serialised local preset store.
 *
 * Every operation re-reads the file inside the queue. A failed write never
 * replaces the previous file (`writeFileAtomic` uses a unique temp file +
 * rename), and an unreadable or malformed store never gets overwritten.
 */
export function createAppearancePresetStore(directory: () => string): AppearancePresetStore {
  let queue = Promise.resolve()

  const enqueue = <T>(action: (file: string) => Promise<T>): Promise<T> => {
    const task = queue.then(() => action(join(directory(), APPEARANCE_PRESET_FILE)))
    queue = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  return {
    list: () =>
      enqueue(async (file) => {
        const store = await readStore(file)
        return store.presets.map(summarizeAppearancePreset).sort(byUpdated)
      }),

    get: (id) =>
      enqueue(async (file) => {
        if (typeof id !== 'string' || !id) return null
        const store = await readStore(file)
        return store.presets.find((preset) => preset.id === id) ?? null
      }),

    remove: (id) =>
      enqueue(async (file) => {
        if (typeof id !== 'string' || !id) throw new DataError('NOT_FOUND', '外观预设不存在')
        const store = await readStore(file)
        if (!store.writable) {
          throw new DataError('READ_FAILED', '外观预设文件异常，已保留原文件，未删除预设')
        }
        const nextPresets = store.presets.filter((preset) => preset.id !== id)
        if (nextPresets.length === store.presets.length) {
          throw new DataError('NOT_FOUND', '外观预设不存在')
        }
        const next: PresetFile = { version: APPEARANCE_PRESET_VERSION, presets: nextPresets }
        try {
          await writeFileAtomic(file, JSON.stringify(next, null, 2))
        } catch (error) {
          throw new DataError('SAVE_FAILED', '删除外观预设失败，已保留原有预设', error)
        }
        return nextPresets.map(summarizeAppearancePreset).sort(byUpdated)
      })
  }
}
