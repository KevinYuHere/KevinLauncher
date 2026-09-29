// Stable entry point of the packaged launcher.
//
// The real application code lives in `resources/app-<version>/` (see
// electron-builder.yml + scripts/afterPack.js). Keeping the entry tiny and
// version-independent is what lets an update replace the whole application while
// it is running: the new version is written into a fresh `app-<version>`
// directory (nothing in use is touched) and only `resources/app-version.txt`
// changes before the normal restart. See docs/INSTALLER.md.
const fs = require('node:fs')
const path = require('node:path')

const resources = process.resourcesPath

/** Reads the version pointer, ignoring a missing/corrupt file. */
function currentVersion() {
  try {
    return fs.readFileSync(path.join(resources, 'app-version.txt'), 'utf8').trim()
  } catch {
    return ''
  }
}

/** Every `app-<version>` directory present, best candidate first. */
function candidates() {
  const list = []
  const preferred = currentVersion()
  if (preferred) list.push(path.join(resources, `app-${preferred}`))
  try {
    for (const entry of fs.readdirSync(resources, { withFileTypes: true })) {
      // Directories only: `app-version.txt` also starts with "app-".
      if (entry.isDirectory() && entry.name.startsWith('app-')) {
        list.push(path.join(resources, entry.name))
      }
    }
  } catch {
    /* resources unreadable: handled below */
  }
  return list
}

for (const dir of candidates()) {
  const main = path.join(dir, 'out', 'main', 'index.js')
  if (fs.existsSync(main)) {
    require(main)
    return
  }
}

throw new Error('找不到应用代码：resources/app-<version> 目录缺失')
