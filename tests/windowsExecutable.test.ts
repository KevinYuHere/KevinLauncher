import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'
import { afterEach, beforeEach, expect, it } from 'vitest'

const { assertElevated, prepareWindowsExecutable } = createRequire(import.meta.url)('../scripts/windows-executable.js')
const brandedIcon = new URL('../resources/icon.ico', import.meta.url)
const originalIcon = new Data.RawIconItem(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YQAAAAASUVORK5CYII=', 'base64'
), 1, 1, 32)
const manifest = '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n' +
  '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">\r\n' +
  '  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>' +
  '<requestedExecutionLevel uiAccess="false" level=\'asInvoker\' />' +
  '</requestedPrivileges></security></trustInfo>\r\n' +
  '  <description>Windows 权限测试</description>\r\n</assembly>'

let directory: string
let file: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kevin-exe-test-'))
  file = join(directory, '测试 启动器.exe')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function fixture(xml: string) {
  const exe = NtExecutable.createEmpty(false, false)
  const resources = NtExecutableResource.from(exe)
  for (const lang of [1033, 2052]) {
    resources.replaceResourceEntryFromString(24, 1, lang, xml)
  }
  resources.replaceResourceEntryFromString(10, 123, 1033, 'unrelated resource')
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, [originalIcon])
  resources.outputResource(exe)
  writeFileSync(file, Buffer.from(exe.generate()))
}

it('edits only the manifest level, keeps unrelated resources, and installs the current icon', () => {
  fixture(manifest)
  expect(() => assertElevated(file)).toThrow('is asInvoker')
  prepareWindowsExecutable(file, brandedIcon)
  assertElevated(file)

  const resources = NtExecutableResource.from(NtExecutable.from(readFileSync(file)))
  const expected = manifest.replace('asInvoker', 'requireAdministrator')
  const manifests = resources.entries.filter(entry => entry.type === 24 && entry.id === 1)
  expect(manifests.map(entry => [entry.lang, Buffer.from(entry.bin)])).toEqual([
    [1033, Buffer.from(expected)], [2052, Buffer.from(expected)]
  ])
  expect(resources.getResourceEntriesAsString(10, 123)).toEqual([[1033, 'unrelated resource']])
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries)
  const expectedFrames = Data.IconFile.from(readFileSync(brandedIcon)).icons.map(icon => icon.data)
  const frames = groups[0].getIconItemsFromEntries(resources.entries)
  const bytes = (frame: typeof frames[number]) => Buffer.from(frame.isRaw() ? frame.bin : frame.generate())
  expect(frames.map(bytes)).toEqual(expectedFrames.map(bytes))
})

it('rejects an unrecognizable manifest without altering the executable', () => {
  fixture(manifest.replace(" level='asInvoker'", ''))
  const original = readFileSync(file)
  expect(() => prepareWindowsExecutable(file, brandedIcon)).toThrow('invalid or unsupported requestedExecutionLevel')
  expect(readFileSync(file)).toEqual(original)
})
