// Extracts the CHANGELOG.md section for one version.
//
//   node scripts/extract-changelog.mjs <version> [outputFile]
//
// Prints (or writes) that section, and **exits non-zero when CHANGELOG.md is
// missing or has no section for the version** — both the local release script
// and the CI workflow refuse to publish in that case.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const version = (process.argv[2] ?? '').trim().replace(/^v/, '')
const outFile = process.argv[3]

if (!version) {
  console.error('用法: node scripts/extract-changelog.mjs <版本> [输出文件]')
  process.exit(2)
}

const file = resolve(import.meta.dirname, '..', 'CHANGELOG.md')
let text
try {
  text = readFileSync(file, 'utf8')
} catch {
  console.error(`找不到 CHANGELOG.md（${file}）——已拒绝发布。`)
  process.exit(1)
}

// Escape regex metacharacters so "1.0.2" cannot match "1x0x2".
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const heading = new RegExp(`^##\\s*\\[?v?${escaped}\\]?(\\s|$)`)

const lines = text.split(/\r?\n/)
const start = lines.findIndex((line) => heading.test(line))
if (start < 0) {
  console.error(`CHANGELOG.md 中没有 ${version} 的段落——已拒绝发布。`)
  console.error('（请先在 CHANGELOG.md 最上方添加该版本的内容，再发布。）')
  process.exit(1)
}

let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s/.test(lines[i])) {
    end = i
    break
  }
}

const section = `${lines.slice(start, end).join('\n').trimEnd()}\n`
if (outFile) {
  writeFileSync(outFile, section, 'utf8')
  console.log(`CHANGELOG.md: 已抽取 ${version} 的说明 → ${outFile}`)
} else {
  process.stdout.write(section)
}
