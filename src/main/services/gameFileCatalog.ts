import { resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync as SqliteConnection, StatementSync } from 'node:sqlite'
import { GAME_FILE_CATALOG_NAME } from '@shared/paths'
import type { FileIdentity } from './windowsFileIdentity'

// Vite 5 normalizes Node's prefix-only builtins to their bare IDs in SSR.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

const FORMAT_ID = 0x4b4c484f // KLHO
const CATALOG_AGE = 120 * 24 * 60 * 60_000
const CATALOG_ROWS = 250_000
const CANDIDATES = 128
const lastPrune = new Map<string, number>()

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
  private storeContent: StatementSync | undefined
  private writes = 0

  constructor(userDataDirectory: string) {
    this.path = resolve(userDataDirectory, GAME_FILE_CATALOG_NAME)
  }

  private open(): SqliteConnection {
    if (this.database) return this.database
    const database = new DatabaseSync(this.path)
    try {
      database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_size_limit = 16777216;')
      let version = database.prepare('PRAGMA user_version;').get()?.user_version
      const format = database.prepare('PRAGMA application_id;').get()?.application_id
      if (!(version === 0 && format === 0) && !((version === 1 || version === 2) && format === FORMAT_ID)) {
        throw new Error('unrecognized game file catalog format')
      }
      if (version !== 2) {
        // Serialize first-open and migration across the independent download workers.
        database.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;')
        version = database.prepare('PRAGMA user_version;').get()?.user_version
      }
      if (version === 0) {
        database.exec(`
          CREATE TABLE IF NOT EXISTS indexed_content (
            location TEXT PRIMARY KEY,
            content_key TEXT NOT NULL,
            modified_ticks INTEGER NOT NULL,
            content_length INTEGER NOT NULL,
            checksum TEXT NOT NULL,
            game_owner TEXT NOT NULL,
            volume_serial INTEGER NOT NULL,
            file_low INTEGER NOT NULL,
            file_high INTEGER NOT NULL,
            last_used INTEGER NOT NULL
          ) WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS content_by_age
            ON indexed_content (content_key, modified_ticks);
          CREATE INDEX catalog_last_used ON indexed_content (last_used);
          PRAGMA application_id = ${FORMAT_ID};
          PRAGMA user_version = 2;
          COMMIT;
        `)
      } else if (version === 1) {
        database.exec(`
          ALTER TABLE indexed_content ADD COLUMN last_used INTEGER NOT NULL DEFAULT 0;
          CREATE INDEX catalog_last_used ON indexed_content (last_used);
          PRAGMA user_version = 2;
        `)
        database.prepare('UPDATE indexed_content SET last_used = ?').run(Date.now())
        database.exec('COMMIT;')
      } else if (database.isTransaction) {
        database.exec('COMMIT;')
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
        LIMIT ${CANDIDATES}
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
    const database = this.open()
    this.storeContent ??= database.prepare(`
      REPLACE INTO indexed_content
        (location, content_key, modified_ticks, content_length, checksum, game_owner, volume_serial, file_low, file_high, last_used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.storeContent.run(
      resolve(file.path), contentKey(file.length, file.digest), file.modified, file.length, file.digest,
      file.game, file.volumeId, file.lowId, file.highId, Date.now()
    )
    if (++this.writes % 2048 === 0) this.prune(database, true)
  }

  touch(path: string): void {
    this.open().prepare('UPDATE indexed_content SET last_used = ? WHERE location = ? AND last_used < ?')
      .run(Date.now(), resolve(path), Date.now() - 24 * 60 * 60_000)
  }

  private prune(database: SqliteConnection, force: boolean): void {
    const now = Date.now()
    if (!force && now - (lastPrune.get(this.path) ?? 0) < 60 * 60_000) return
    lastPrune.set(this.path, now)
    database.prepare('DELETE FROM indexed_content WHERE last_used < ?').run(now - CATALOG_AGE)
    database.prepare(`
      DELETE FROM indexed_content WHERE location IN (
        SELECT location FROM indexed_content ORDER BY last_used DESC LIMIT -1 OFFSET ?
      )
    `).run(CATALOG_ROWS)
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
    try {
      if (this.database) this.prune(this.database, false)
    } finally {
      this.database?.close()
      this.database = undefined
      this.findContent = undefined
      this.storeContent = undefined
    }
  }
}
