import { useState, type ReactElement } from 'react'
import {
  discoveredGameToNewApp,
  isGameDiscoveryCandidateAlreadyAdded,
  normalizeGamePath,
  type GameDiscoveryCandidate,
  type GameDiscoveryResult
} from '@shared/gameDiscovery'
import Checkbox from './Checkbox'
import { showToast } from './toast'

interface GameDiscoveryProps {
  /** Let the welcome page refresh its app list after the confirmed import. */
  onAdded?: () => void
}

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^\[[A-Z_]+\]\s*/, '')

const candidateKey = (candidate: GameDiscoveryCandidate): string =>
  `${candidate.game}|${normalizeGamePath(candidate.installDirectory)}`

const sourceLabel = (source: GameDiscoveryCandidate['source']): string =>
  source === 'registry' ? '系统记录' : '常见位置'

/**
 * User-triggered four-game discovery card.
 *
 * Scanning is explicit (never on mount). Results are shown for review, each
 * candidate is checked separately, and the final confirmation checkbox gates
 * the existing `apps:add` command. This component never writes config itself.
 */
export default function GameDiscovery({ onAdded }: GameDiscoveryProps): ReactElement {
  const [result, setResult] = useState<GameDiscoveryResult | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmed, setConfirmed] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')

  const scan = async (): Promise<void> => {
    setScanning(true)
    setError('')
    setResult(null)
    setSelected(new Set())
    setConfirmed(false)
    setAddedKeys(new Set())
    try {
      const next = await window.api.gameDiscoveryScan()
      setResult(next)
      if (next.candidates.length === 0) {
        showToast('没有在系统记录或常见安装目录中找到原神、崩坏：星穹铁道、绝区零或明日方舟')
      }
    } catch (scanError) {
      const message = errorText(scanError)
      setError(`扫描本机游戏失败：${message}`)
      showToast(`扫描本机游戏失败：${message}`)
    } finally {
      setScanning(false)
    }
  }

  const cancel = (): void => {
    setResult(null)
    setSelected(new Set())
    setConfirmed(false)
    setAddedKeys(new Set())
    setError('')
  }

  const toggle = (candidate: GameDiscoveryCandidate): void => {
    const key = candidateKey(candidate)
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setConfirmed(false)
  }

  const selectable = (candidate: GameDiscoveryCandidate): boolean =>
    !candidate.alreadyAdded && !addedKeys.has(candidateKey(candidate))

  const selectedCandidates =
    result?.candidates.filter((candidate) => selectable(candidate) && selected.has(candidateKey(candidate))) ??
    []

  const addSelected = async (): Promise<void> => {
    if (!confirmed || selectedCandidates.length === 0 || adding) return
    setAdding(true)
    setError('')
    let added = 0
    let skipped = 0
    const failures: string[] = []
    try {
      const apps = await window.api.listApps()
      const justAdded = new Set(addedKeys)
      for (const candidate of selectedCandidates) {
        const key = candidateKey(candidate)
        if (justAdded.has(key) || isGameDiscoveryCandidateAlreadyAdded(candidate, apps)) {
          skipped++
          justAdded.add(key)
          continue
        }
        try {
          const app = await window.api.addApp(discoveredGameToNewApp(candidate))
          apps.push(app)
          justAdded.add(key)
          added++
        } catch (error) {
          failures.push(`「${candidate.name}」${errorText(error)}`)
        }
      }
      setAddedKeys(justAdded)
      setSelected(new Set())
      setConfirmed(false)
      if (added) {
        onAdded?.()
        showToast(`已添加 ${added} 款游戏${skipped ? `，跳过 ${skipped} 个已存在项` : ''}`)
      } else if (skipped && failures.length === 0) {
        showToast('所选游戏都已经存在，没有重复添加')
      }
      if (failures.length) {
        const detail = failures.join('；')
        setError(`${failures.length} 款游戏添加失败：${detail}`)
        showToast(`有 ${failures.length} 款游戏添加失败：${detail}`)
      }
    } catch (addError) {
      const message = errorText(addError)
      setError(`读取应用列表失败：${message}`)
      showToast(`添加游戏失败：${message}`)
    } finally {
      setAdding(false)
    }
  }

  return (
    <section className="game-discovery" aria-label="扫描本机游戏">
      <div className="game-discovery-head">
        <div className="game-discovery-copy">
          <div className="game-discovery-title">扫描本机游戏</div>
          <div className="game-discovery-desc">
            只读取系统记录和几个常见安装目录，不启动游戏，也不会改动游戏文件。能否更新请以更新页的检测结果为准。
          </div>
        </div>
        <div className="game-discovery-actions">
          {result && (
            <button className="btn sm ghost" onClick={cancel} disabled={scanning || adding}>
              取消
            </button>
          )}
          <button className="btn sm" onClick={() => void scan()} disabled={scanning || adding}>
            {scanning ? '扫描中…' : '扫描本机游戏'}
          </button>
        </div>
      </div>

      {error && (
        <div className="game-discovery-error" role="alert">
          {error}
        </div>
      )}

      {result && result.warnings.length > 0 && (
        <div className="game-discovery-warning">
          {result.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}

      {!result && !scanning && (
        <div className="game-discovery-hint">
          扫描结果只是候选，勾选并确认后才会加入启动器；取消不会改动任何设置。
        </div>
      )}

      {result && result.candidates.length === 0 && (
        <div className="game-discovery-empty">
          没有找到原神、崩坏：星穹铁道、绝区零或明日方舟的安装。可检查安装位置后重新扫描。
        </div>
      )}

      {result && result.candidates.length > 0 && (
        <div className="game-discovery-list">
          {result.candidates.map((candidate) => {
            const key = candidateKey(candidate)
            const added = candidate.alreadyAdded || addedKeys.has(key)
            return (
              <div className={`game-discovery-item${added ? ' added' : ''}`} key={key}>
                <Checkbox
                  checked={!added && selected.has(key)}
                  disabled={added || adding}
                  onChange={() => toggle(candidate)}
                  title={added ? '已在启动器中' : `选择${candidate.name}`}
                />
                <div className="game-discovery-item-main">
                  <div className="game-discovery-item-title">
                    {candidate.name}
                    <span className="game-discovery-badge">{sourceLabel(candidate.source)}</span>
                    {added && <span className="game-discovery-badge added">已添加</span>}
                  </div>
                  <div className="game-discovery-path" title={candidate.executablePath}>
                    {candidate.executablePath}
                  </div>
                  <div className="game-discovery-meta">
                    已核对启动文件与安装目录特征：{candidate.marker}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {result && result.candidates.length > 0 && (
        <div className="game-discovery-confirm">
          <Checkbox
            checked={confirmed}
            disabled={selectedCandidates.length === 0 || adding}
            onChange={setConfirmed}
            label="我已核对以上路径，确认添加所选游戏"
          />
          <button
            className="btn sm primary"
            disabled={!confirmed || selectedCandidates.length === 0 || adding}
            onClick={() => void addSelected()}
          >
            {adding ? '添加中…' : `添加所选${selectedCandidates.length ? `（${selectedCandidates.length}）` : ''}`}
          </button>
        </div>
      )}
    </section>
  )
}
