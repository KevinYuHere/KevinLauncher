import type { AddonId } from '@shared/types'
import { runPowerShell } from './powershell'

/** A path string read from the local registry. It is data, never a command. */
export interface RegistryGameCandidate {
  game: AddonId
  path: string
}

const GAME_IDS = new Set<AddonId>(['genshin', 'starrail', 'zzz', 'arknights'])

/**
 * Fixed, read-only registry query. It only reads `InstallPath` /
 * `InstallLocation` strings and the matching `DisplayName`s. Values are emitted
 * as JSON and later treated purely as candidate directory strings — they are
 * never passed to a shell, `Start-Process` or `Invoke-Expression`.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$rows = New-Object System.Collections.Generic.List[object]
function Add-Row([string]$game, $path) {
  if ($path -is [string]) {
    $value = $path.Trim()
    if ($value.Length -gt 0) {
      $rows.Add([pscustomobject]@{ game = $game; path = $value })
    }
  }
}
$direct = @(
  @{ game = 'genshin'; key = 'HKCU:\Software\miHoYo\Genshin Impact'; name = 'InstallPath' },
  @{ game = 'genshin'; key = 'HKLM:\SOFTWARE\miHoYo\Genshin Impact'; name = 'InstallPath' },
  @{ game = 'genshin'; key = 'HKCU:\Software\miHoYo\原神'; name = 'InstallPath' },
  @{ game = 'genshin'; key = 'HKLM:\SOFTWARE\miHoYo\原神'; name = 'InstallPath' },
  @{ game = 'starrail'; key = 'HKCU:\Software\miHoYo\Star Rail'; name = 'InstallPath' },
  @{ game = 'starrail'; key = 'HKLM:\SOFTWARE\miHoYo\Star Rail'; name = 'InstallPath' },
  @{ game = 'starrail'; key = 'HKCU:\Software\miHoYo\崩坏：星穹铁道'; name = 'InstallPath' },
  @{ game = 'starrail'; key = 'HKLM:\SOFTWARE\miHoYo\崩坏：星穹铁道'; name = 'InstallPath' },
  @{ game = 'zzz'; key = 'HKCU:\Software\miHoYo\ZenlessZoneZero'; name = 'InstallPath' },
  @{ game = 'zzz'; key = 'HKLM:\SOFTWARE\miHoYo\ZenlessZoneZero'; name = 'InstallPath' },
  @{ game = 'zzz'; key = 'HKCU:\Software\miHoYo\绝区零'; name = 'InstallPath' },
  @{ game = 'zzz'; key = 'HKLM:\SOFTWARE\miHoYo\绝区零'; name = 'InstallPath' },
  @{ game = 'arknights'; key = 'HKCU:\Software\Hypergryph\Arknights'; name = 'InstallPath' },
  @{ game = 'arknights'; key = 'HKLM:\SOFTWARE\Hypergryph\Arknights'; name = 'InstallPath' },
  @{ game = 'arknights'; key = 'HKLM:\SOFTWARE\WOW6432Node\Hypergryph\Arknights'; name = 'InstallPath' },
  @{ game = 'arknights'; key = 'HKCU:\Software\Hypergryph\明日方舟'; name = 'InstallPath' },
  @{ game = 'arknights'; key = 'HKLM:\SOFTWARE\Hypergryph\明日方舟'; name = 'InstallPath' },
  @{ game = 'arknights'; key = 'HKLM:\SOFTWARE\WOW6432Node\Hypergryph\明日方舟'; name = 'InstallPath' }
)
foreach ($entry in $direct) {
  $item = Get-ItemProperty -LiteralPath $entry.key -ErrorAction SilentlyContinue
  if ($null -eq $item) { continue }
  $property = $item.PSObject.Properties[$entry.name]
  if ($null -ne $property) { Add-Row $entry.game $property.Value }
}
$names = @{
  '原神' = 'genshin'
  'Genshin Impact' = 'genshin'
  '崩坏：星穹铁道' = 'starrail'
  '崩坏:星穹铁道' = 'starrail'
  'Star Rail' = 'starrail'
  '绝区零' = 'zzz'
  'ZenlessZoneZero' = 'zzz'
  'Zenless Zone Zero' = 'zzz'
  '明日方舟' = 'arknights'
  'Arknights' = 'arknights'
}
$roots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($root in $roots) {
  foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
    $item = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
    if ($null -eq $item) { continue }
    $display = ([string]$item.DisplayName).Trim()
    $game = $names[$display]
    if ($null -eq $game) { continue }
    Add-Row $game $item.InstallLocation
  }
}
$result = @($rows)
if ($result.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $result -Compress -Depth 4 }
`

/** Parse registry output defensively; malformed rows are ignored as data. */
export function parseGameRegistryCandidates(raw: string): RegistryGameCandidate[] {
  const text = raw.replace(/^\uFEFF/, '').trim()
  if (!text) return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('本机游戏登记信息格式无效')
  }
  const rows = Array.isArray(value) ? value : [value]
  const result: RegistryGameCandidate[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const { game, path } = row as { game?: unknown; path?: unknown }
    if (typeof game !== 'string' || !GAME_IDS.has(game as AddonId)) continue
    if (typeof path !== 'string') continue
    const candidate = path.trim()
    if (!candidate || candidate.length > 32_767 || candidate.includes('\0')) continue
    const key = `${game}\0${candidate.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ game: game as AddonId, path: candidate })
  }
  return result
}

/** Read registry candidates. The caller decides how failures are surfaced. */
export async function readGameRegistryCandidates(): Promise<RegistryGameCandidate[]> {
  try {
    const output = await runPowerShell(SCRIPT, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })
    return parseGameRegistryCandidates(output)
  } catch (error) {
    if (error instanceof Error && error.message === '本机游戏登记信息格式无效') throw error
    throw new Error('无法读取本机游戏登记')
  }
}
