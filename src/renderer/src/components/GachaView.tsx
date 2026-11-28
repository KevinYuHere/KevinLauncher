import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AddonDescriptor, AppEntry, GachaPoolStat, GachaRecordPage, GachaStats } from '@shared/types'
import { displayRank, failureText, rankClass } from '../format'
import { confirm } from './confirm'
import Switch from './Switch'
import InlineEdit from './InlineEdit'

// Gacha history for the current app: a per-banner breakdown with 5★/4★ stats,
// pity counters and the raw record list. Records are fetched outside the render
// (main process scans the game's web cache); `updating` locks the actions while
// a fetch from any app is in flight.
interface GachaViewProps {
  entry: AppEntry
  addon: AddonDescriptor | undefined
  onBack: () => void
  onToast: (message: string) => void
  /** True while any app's gacha records are being fetched. */
  updating: boolean
}

export default function GachaView({
  entry,
  onBack,
  onToast,
  updating
}: GachaViewProps): ReactElement {
  const isArknights = entry.addonId === 'arknights'
  const locked = (): boolean => busy || updating
  const [stats, setStats] = useState<GachaStats | null>(null)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [url, setUrl] = useState('')
  // A scanned link is held here instead of the editor so the auth parameter is
  // never rendered. Manual links keep working through the normal editor.
  const [capturedUrl, setCapturedUrl] = useState('')
  const [captureStatus, setCaptureStatus] = useState('')
  const [busy, setBusy] = useState(false)
  // Per-app (persisted): whether the second-highest rarity is shown.
  const showSecond = entry.gachaShowSecond ?? true

  useEffect(() => {
    return window.api.onGachaChanged((appId) => {
      if (appId === null || appId === entry.id) setRevision((value) => value + 1)
    })
  }, [entry.id])

  useEffect(() => {
    let active = true
    void window.api.gachaStats(entry.id).then((next) => {
      if (!active) return
      setStats(next)
      setError('')
    }).catch((failure: unknown) => {
      if (active) {
        setError(failureText(failure, '读取抽卡记录失败。请稍后重试。若仍失败，请到设置中检查游戏模块绑定。'))
      }
    })
    return () => { active = false }
  }, [entry.id, entry.addonId, revision])

  const performUpdate = useCallback(
    async (source: string, mode: 'incremental' | 'full'): Promise<void> => {
      try {
        const result = await window.api.gachaUpdateMiHoYo(entry.id, source.trim(), mode)
        onToast(result.message ?? `更新完成：新增 ${result.added} 条，共 ${result.total} 条`)
      } catch (error) {
        onToast(failureText(
          error,
          mode === 'full'
            ? '重新获取全部记录失败。请确认已在游戏内打开过「抽卡记录」，并检查网络后重试。'
            : '更新抽卡记录失败。请确认已在游戏内打开过「抽卡记录」，并检查网络后重试。'
        ))
      }
    },
    [entry.id, onToast]
  )

  const updateMiHoYo = useCallback(
    async (mode: 'incremental' | 'full' = 'incremental'): Promise<void> => {
      const source = (url.trim() || capturedUrl).trim()
      if (!source) {
        onToast('请先粘贴抽卡记录链接，或点「自动获取并更新」。')
        return
      }
      setBusy(true)
      try {
        await performUpdate(source, mode)
      } finally {
        setBusy(false)
      }
    },
    [capturedUrl, onToast, performUpdate, url]
  )

  const scanAndUpdate = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const scanned = await window.api.gachaScanUrl(entry.id)
      if (!scanned) {
        onToast('没有找到抽卡链接。请先在游戏内打开「抽卡记录」页面，再回来点「自动获取并更新」。也可以直接粘贴链接。')
        return
      }
      setUrl('')
      setCapturedUrl(scanned)
      setCaptureStatus('已从游戏缓存读取抽卡链接。登录信息只保留在本页，不会显示或写入日志。')
      await performUpdate(scanned, 'incremental')
    } catch (error) {
      onToast(failureText(
        error,
        '读取游戏缓存失败。请确认游戏已登录并打开过「抽卡记录」，也可以直接粘贴链接后重试。'
      ))
    } finally {
      setBusy(false)
    }
  }, [entry.id, onToast, performUpdate])

  const loginArknights = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.gachaLoginArknights(entry.id)
      onToast(result.message ?? `更新完成：新增 ${result.added} 条，共 ${result.total} 条`)
    } catch (error) {
      onToast(failureText(error, '获取抽卡记录失败。请完成鹰角账号登录，并检查网络后重试。'))
    } finally {
      setBusy(false)
    }
  }, [entry.id, onToast])

  const doExport = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.gachaExport(entry.id)
      if (result) {
        onToast(result.format === 'uigf'
          ? `已导出为 UIGF v4.2 文件：${result.path}`
          : `已导出 KevinLauncher 备份：${result.path}`)
      }
    } catch (error) {
      onToast(failureText(error, '导出失败。请确认保存位置可写，或换一个位置后重试。'))
    }
  }, [entry.id, onToast])

  const doImport = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const added = await window.api.gachaImport(entry.id)
      if (added !== null) onToast(`导入完成：新增 ${added} 条`)
    } catch (error) {
      onToast(failureText(
        error,
        '导入失败。请选择有效的 UIGF 或 KevinLauncher 备份文件，并确认它属于当前游戏。'
      ))
    } finally {
      setBusy(false)
    }
  }, [entry.id, onToast])

  const doClear = useCallback(async (): Promise<void> => {
    if (!(await confirm('将删除该应用的全部抽卡记录，此操作无法撤销。确定清空吗？'))) return
    try {
      await window.api.gachaClear(entry.id)
      onToast('抽卡记录已清空')
    } catch (error) {
      onToast(failureText(error, '清空失败。若有记录正在获取，请等待完成后再试。'))
    }
  }, [entry.id, onToast])

  const topRank = stats?.topRank ?? 5
  const secondRank = stats?.secondRank ?? null
  const pityHint = isArknights
    ? '记录不足，补全更早的寻访记录后计算'
    : '记录不足，更新或导入更早记录后计算'
  const pityHintTitle = isArknights
    ? '请重新登录鹰角账号获取完整寻访记录，或导入包含更早记录的备份'
    : '请先在游戏内打开「抽卡记录」再点更新，或导入包含更早记录的备份'

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{entry.name} · 抽卡记录</h1>
          <p className="page-subtitle" role={error ? 'alert' : undefined}>
            {error || (stats && stats.total > 0 ? `共 ${stats.total} 条记录` : stats ? '尚未获取记录' : '正在读取记录…')}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={onBack}>
            返回主页
          </button>
        </div>
      </div>

      <div className="page-body">
        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">获取抽卡记录</div>
          </div>
          <div className="panel-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {isArknights ? (
              <button className="btn primary" disabled={locked()} onClick={() => void loginArknights()}>
                {busy ? '获取中…' : '登录鹰角账号并获取抽卡记录'}
              </button>
            ) : (
              <>
                <div className="gacha-url" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <InlineEdit
                    className="wide"
                    value={url}
                    placeholder="粘贴抽卡记录链接，或点「自动获取并更新」"
                    onCommit={(value) => {
                      setUrl(value)
                      setCapturedUrl('')
                      setCaptureStatus('')
                    }}
                  />
                  {captureStatus && (
                    <span className="hint" title="读取到的链接只在当前页面使用，离开后需要重新获取">
                      {captureStatus}
                    </span>
                  )}
                </div>
                <button className="btn" disabled={locked()} onClick={() => void scanAndUpdate()}>
                  自动获取并更新
                </button>
                <button className="btn primary" disabled={locked()} onClick={() => void updateMiHoYo()}>
                  {busy ? '更新中…' : '更新记录'}
                </button>
                <button
                  className="btn ghost"
                  disabled={locked()}
                  title="从最早记录开始重新获取全部历史。耗时较长，日常更新用「更新记录」即可"
                  onClick={() => void updateMiHoYo('full')}
                >
                  重新获取全部记录
                </button>
              </>
            )}
            <button className="btn" disabled={locked()} title="从 UIGF 或 KevinLauncher 备份文件导入记录" onClick={() => void doImport()}>
              导入记录
            </button>
            <button className="btn" disabled={locked()} title="导出为 UIGF 或 KevinLauncher 备份文件" onClick={() => void doExport()}>
              导出记录
            </button>
            <button className="btn ghost" disabled={locked()} title="删除本应用的全部抽卡记录，无法撤销" onClick={() => void doClear()}>
              清空记录
            </button>
          </div>
        </div>

        {stats && stats.total > 0 && (
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-value">{stats.total}</div>
              <div className="stat-label">总抽数</div>
            </div>
            <div className="stat-card">
              <div className={`stat-value ${rankClass(topRank, topRank)}`}>
                {stats.rankCounts[String(topRank)] ?? 0}
              </div>
              <div className="stat-label">最高 {displayRank(entry.addonId, topRank)}</div>
            </div>
            {secondRank != null && (
              <div className="stat-card">
                <div className={`stat-value ${rankClass(secondRank, topRank)}`}>
                  {stats.rankCounts[String(secondRank)] ?? 0}
                </div>
                <div className="stat-label">次高 {displayRank(entry.addonId, secondRank)}</div>
              </div>
            )}
          </div>
        )}

        <div className="pools-bar">
          <div className="panel-title">各卡池（保底分别计算）</div>
          <Switch
            checked={showSecond}
            label="在卡池中显示次高品级"
            title="开启后在各卡池显示次高品级的保底进度与记录。顶部统计不受影响"
            onChange={(value) => void window.api.setGachaShowSecond(entry.id, value)}
          />
        </div>

        {stats && stats.pools.length === 0 ? (
          <div className="panel">
            <div className="empty">
              <div className="empty-icon" aria-hidden="true">✦</div>
              <div className="empty-title">暂无抽卡记录</div>
              <div>
                {isArknights
                  ? '点击上方「登录鹰角账号并获取抽卡记录」开始获取'
                  : '先在游戏内打开一次「抽卡记录」，再点「更新记录」或「自动获取并更新」'}
              </div>
            </div>
          </div>
        ) : (
          <div className="pools">
            {stats?.pools.map((pool) => {
              return (
                <div className="pool-col" key={pool.group}>
                  <div className="pool-col-head">
                    <div className="pool-col-name">{pool.bannerName}</div>
                    <div className="pool-col-count">{pool.uid ? `UID ${pool.uid}` : '未记录 UID'} · {pool.count} 抽</div>
                  </div>

                  <div className="pool-pity">
                    <div className="pool-pity-line">
                      <span className="pp-tier">最高 {displayRank(entry.addonId, pool.topRank)}</span>
                      <span className="pp-val" title={pool.topPityKnown ? undefined : pityHintTitle}>
                        {pool.topPityKnown ? `已 ${pool.topPity} 抽未出` : pityHint}
                      </span>
                    </div>
                    {showSecond && pool.secondRank != null && (
                      <div className="pool-pity-line">
                        <span className="pp-tier">
                          次高 {displayRank(entry.addonId, pool.secondRank)}
                        </span>
                        <span className="pp-val" title={pool.secondPityKnown ? undefined : pityHintTitle}>
                          {pool.secondPityKnown ? `已 ${pool.secondPity ?? 0} 抽未出` : pityHint}
                        </span>
                      </div>
                    )}
                  </div>

                  <PoolRecords
                    key={String(showSecond)}
                    appId={entry.id} pool={pool} showSecond={showSecond} revision={revision}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function PoolRecords({
  appId, pool, showSecond, revision
}: { appId: string; pool: GachaPoolStat; showSecond: boolean; revision: number }): ReactElement {
  const [page, setPage] = useState<GachaRecordPage | null>(null)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.api.gachaPage(appId, pool.group, showSecond, offset).then((next) => {
      if (!active) return
      if (next.offset > 0 && next.offset >= next.matched) {
        setOffset(Math.max(0, Math.floor((next.matched - 1) / next.limit) * next.limit))
        return
      }
      setPage(next)
      setError('')
    }).catch((failure: unknown) => {
      if (active) {
        setError(failureText(failure, '读取该卡池记录失败。请返回主页后重新进入抽卡记录页。'))
      }
    })
    return () => { active = false }
  }, [appId, pool.group, showSecond, offset, revision])

  return (
    <div className="pool-records">
      {error && <div className="pool-empty" role="alert">{error}</div>}
      {page?.records.map((record) => (
        <div className="pool-row" key={record.id}>
          <span className={`rank ${rankClass(record.rankType, pool.topRank)}`}>
            {displayRank(pool.game, record.rankType)}
          </span>
          <span className="pool-row-name">{record.itemName || record.itemId}</span>
          <span className="pool-row-pity">{record.pityAtPull ?? '—'}</span>
        </div>
      ))}
      {page?.matched === 0 && <div className="pool-empty">没有符合当前品级的记录</div>}
      {page && page.matched > page.limit && (
        <div className="pool-col-head">
          <button className="btn sm ghost" disabled={page.offset === 0 || offset !== page.offset} onClick={() => setOffset(page.offset - page.limit)}>
            上一页
          </button>
          <span className="pool-col-count">{page.offset + 1}–{page.offset + page.records.length} / {page.matched}</span>
          <button className="btn sm ghost" disabled={page.offset + page.limit >= page.matched || offset !== page.offset} onClick={() => setOffset(page.offset + page.limit)}>
            下一页
          </button>
        </div>
      )}
    </div>
  )
}
