import { resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync as SqliteConnection, StatementSync } from 'node:sqlite'
import { GAME_FILE_CATALOG_NAME } from '@shared/paths'
import type { FileIdentity } from './windowsFileIdentity'

// Vite 5 normalizes Node's prefix-only builtins to their bare IDs in SSR.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

const FORMAT_ID = 0x4b4c484f // KLHO

export interface IndexedGameFile extends FileIdentity {
  path: string
  game: string
  length: bigint
  digest: string
  modified: bigint
}

interface CatalogRow {
  location: string
  game_owner: string
  content_length: bigint
  checksum: string
  modified_ticks: bigint
  volume_serial: bigint
  file_low: bigint
  file_high: bigint
}

const contentKey = (length: bigint, digest: string): string => `${length}:${digest}`

/** App-owned index of verified file contents. It never opens another launcher's files. */
export class GameFileCatalog {
  readonly path: string
  private database: SqliteConnection | undefined
  private findContent: StatementSync | undefined

  constructor(userDataDirectory: string) {
    this.path = resolve(userDataDirectory, GAME_FILE_CATALOG_NAME)
  }

  private open(): SqliteConnection {
    if (this.database) return this.database
    const database = new DatabaseSync(this.path)
    try {
      database.exec('PRAGMA busy_timeout = 5000;')
      const version = database.prepare('PRAGMA user_version;').get()?.user_version
      const format = database.prepare('PRAGMA application_id;').get()?.application_id
      if (version === 0 && format === 0) {
        database.exec(`
          PRAGMA journal_mode = WAL;
          BEGIN;
          CREATE TABLE IF NOT EXISTS indexed_content (
            location TEXT PRIMARY KEY,
            content_key TEXT NOT NULL,
            modified_ticks INTEGER NOT NULL,
            content_length INTEGER NOT NULL,
            checksum TEXT NOT NULL,
            game_owner TEXT NOT NULL,
            volume_serial INTEGER NOT NULL,
            file_low INTEGER NOT NULL,
            file_high INTEGER NOT NULL
          ) WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS content_by_age
            ON indexed_content (content_key, modified_ticks);
          PRAGMA application_id = ${FORMAT_ID};
          PRAGMA user_version = 1;
          COMMIT;
        `)
      } else if (version !== 1 || format !== FORMAT_ID) {
        throw new Error('unrecognized game file catalog format')
      }
    } catch (error) {
      database.close()
      throw error
    }
    this.database = database
    return database
  }

  candidates(target: string, length: bigint, digest: string): IndexedGameFile[] {
    const db = this.open()
    if (!this.findContent) {
      this.findContent = db.prepare(`
        SELECT location, game_owner, content_length, checksum, modified_ticks, volume_serial, file_low, file_high
        FROM indexed_content INDEXED BY content_by_age
        WHERE content_key = ?
        ORDER BY modified_ticks ASC
      `)
      this.findContent.setReadBigInts(true)
    }
    const absoluteTarget = resolve(target)
    const rows = this.findContent.all(contentKey(length, digest)) as unknown as CatalogRow[]
    return rows.filter((row) => row.location !== absoluteTarget).map((row) => ({
      path: row.location, game: row.game_owner, length: row.content_length, digest: row.checksum,
      modified: row.modified_ticks, volumeId: row.volume_serial, lowId: row.file_low, highId: row.file_high
    }))
  }

  put(file: IndexedGameFile): void {
    this.open().prepare(`
      REPLACE INTO indexed_content
        (location, content_key, modified_ticks, content_length, checksum, game_owner, volume_serial, file_low, file_high)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      resolve(file.path), contentKey(file.length, file.digest), file.modified, file.length, file.digest,
      file.game, file.volumeId, file.lowId, file.highId
    )
  }

  deleteFile(path: string): void {
    this.open().prepare('DELETE FROM indexed_content WHERE location = ?').run(resolve(path))
  }

  deleteFolder(folder: string): void {
    const absolute = resolve(folder)
    const prefix = absolute.endsWith(sep) ? absolute : absolute + sep
    const literalPrefix = prefix.replace(/[!%_]/g, '!$&')
    this.open().prepare("DELETE FROM indexed_content WHERE location LIKE ? ESCAPE '!'")
      .run(literalPrefix + '%')
  }

  close(): void {
    this.database?.close()
    this.database = undefined
    this.findContent = undefined
  }
}
