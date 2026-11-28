import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit', windowsHide: true })
const base = process.env.KEVIN_LINT_BASE
if (base != null && base !== '' && !/^[0-9a-f]{40}$/.test(base)) {
  throw new Error('代码风格检查的基准提交无效')
}
run('git', ['diff', '--check', ...(base && !/^0+$/.test(base) ? [base, 'HEAD'] : [])])
if (!base) run('git', ['diff', '--cached', '--check'])

// Check tooling syntax without reformatting the existing codebase.
const inputs = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard',
  '--', 'scripts', 'shell', 'package.json', 'package-lock.json'], { encoding: 'utf8', windowsHide: true })
for (const file of new Set(inputs.split('\0'))) {
  if (!file || !existsSync(file)) continue
  if (/\.[cm]?js$/.test(file)) run(process.execPath, ['--check', file])
  if (/\.json$/.test(file)) JSON.parse(readFileSync(file, 'utf8'))
}
