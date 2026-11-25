const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const { Data, NtExecutable, NtExecutableResource, Resource } = require('resedit')

const manifestType = 24 // RT_MANIFEST
const processManifest = 1 // CREATEPROCESS_MANIFEST_RESOURCE_ID
const electronIconGroup = 1
const requiredLevel = 'requireAdministrator'
const executionTag = /<(?:[\w.-]+:)?requestedExecutionLevel\b[^>]*>/g
const levelAttribute = /(\slevel\s*=\s*)(["'])([^"']+)\2/

function manifests(resources, file) {
  const entries = resources.entries.filter(entry => entry.type === manifestType && entry.id === processManifest)
  if (entries.length === 0) throw new Error(`${file}: embedded process manifest is missing`)
  return entries.map(entry => {
    const bytes = Buffer.from(entry.bin)
    const xml = bytes.toString('utf8')
    const tags = xml.match(executionTag)
    const level = tags?.[0].match(levelAttribute)?.[3]
    if (!Buffer.from(xml, 'utf8').equals(bytes) || tags?.length !== 1 || !level) {
      throw new Error(`${file}: invalid or unsupported requestedExecutionLevel in manifest language ${entry.lang}`)
    }
    return { entry, xml, level }
  })
}

function assertElevated(file) {
  const exe = NtExecutable.from(fs.readFileSync(file), { ignoreCert: true })
  for (const { entry, level } of manifests(NtExecutableResource.from(exe), file)) {
    if (level !== requiredLevel) throw new Error(`${file}: manifest language ${entry.lang} is ${level}, expected ${requiredLevel}`)
  }
}

function prepareWindowsExecutable(file, iconFile) {
  const exe = NtExecutable.from(fs.readFileSync(file), { ignoreCert: true })
  const resources = NtExecutableResource.from(exe)
  for (const { entry, xml } of manifests(resources, file)) {
    const revised = xml.replace(executionTag, tag => tag.replace(levelAttribute,
      (_original, key, quote) => `${key}${quote}${requiredLevel}${quote}`))
    entry.bin = Buffer.from(revised, 'utf8')
  }

  const icons = Data.IconFile.from(fs.readFileSync(iconFile)).icons.map(icon => icon.data)
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries).filter(group => group.id === electronIconGroup)
  if (icons.length === 0 || groups.length === 0) throw new Error(`${file}: app icon or Electron icon group is missing`)
  for (const group of groups) {
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons)
  }

  resources.outputResource(exe)
  const staged = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(staged, Buffer.from(exe.generate()), { flag: 'wx', mode: fs.statSync(file).mode })
    fs.renameSync(staged, file)
  } finally {
    fs.rmSync(staged, { force: true })
  }
}

module.exports = { assertElevated, prepareWindowsExecutable }

if (require.main === module) {
  const files = process.argv.slice(2)
  if (files.length === 0) throw new Error('Usage: node scripts/windows-executable.js <exe> [other.exe ...]')
  for (const file of files) {
    assertElevated(file)
    console.log(`Verified ${requiredLevel} in ${file}`)
  }
}
