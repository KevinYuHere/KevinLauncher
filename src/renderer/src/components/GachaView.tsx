import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AddonDescriptor, AppEntry, GachaPoolStat, GachaRecordPage, GachaStats } from '@shared/types'
import { displayRank, rankClass } from '../format'
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
      if (active) setError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => { active = false }
  }, [entry.id, entry.addonId, revision])

  const updateMiHoYo = useCallback(
    async (source: string): Promise<void> => {
      if (!source.trim()) {
        onToast('请先获取或粘贴抽卡链接')
        return
      }
      setBusy(true)
      try {
        const result = await window.api.gachaUpdateMiHoYo(entry.id, source.trim())
        onToast(result.message ?? `更新完成：新增 ${result.added} 条，共 ${result.total} 条`)
      } catch (error) {
        onToast(`更新失败：${(error as Error).message}`)
      } finally {
        setBusy(false)
      }
    },
    [entry.id, onToast]
  )

  const scanAndUpdate = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const scanned = await window.api.gachaScanUrl(entry.id)
      if (scanned) {
        setUrl(scanned)
        await updateMiHoYo(scanned)
      } else {
        onToast('未找到链接：请在游戏内打开一次抽卡记录后重试，或粘贴链接')
      }
    } catch (error) {
      onToast(`扫描失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [entry.id, onToast, updateMiHoYo])

  const loginArknights = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.gachaLoginArknights(entry.id)
      onToast(result.message ?? `更新完成：新增 ${result.added} 条，共 ${result.total} 条`)
    } catch (error) {
      onToast(`获取失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [entry.id, onToast])

  const doExport = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.gachaExport(entry.id)
      if (result) onToast(`已导出${result.format === 'uigf' ? ' UIGF v4.2' : ' KevinLauncher 备份'}到 ${result.path}`)
    } catch (error) {
      onToast(`导出失败：${(error as Error).message}`)
    }
  }, [entry.id, onToast])

  const doImport = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const added = await window.api.gachaImport(entry.id)
      if (added !== null) onToast(`导入完成：新增 ${added} 条`)
    } catch (error) {
      onToast(`导入失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [entry.id, onToast])

  const doClear = useCallback(async (): Promise<void> => {
    if (!(await confirm('确定清空该应用的抽卡记录吗？'))) return
    try {
      await window.api.gachaClear(entry.id)
      onToast('已清空')
    } catch (error) {
      onToast(`清空失败：${(error as Error).message}`)
    }
  }, [entry.id, onToast])

  const topRank = stats?.topRank ?? 5
  const secondRank = stats?.secondRank ?? null

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{entry.name} · 抽卡记录</h1>
          <p className="page-subtitle">
            {error || (stats && stats.total > 0 ? `共 ${stats.total} 条记录` : stats ? '尚未获取记录' : '加载中…')}
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
            <div className="panel-title">获取记录</div>
          </div>
          <div className="panel-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {isArknights ? (
              <button className="btn primary" disabled={locked()} onClick={() => void loginArknights()}>
                {busy ? '获取中…' : '登录鹰角账号并获取记录'}
              </button>
            ) : (
              <>
                <div className="gacha-url">
                  <InlineEdit
                    className="wide"
                    value={url}
                    placeholder="抽卡链接（含 authkey），或点「扫描缓存」自动获取"
                    onCommit={setUrl}
                  />
                </div>
                <button className="btn" disabled={locked()} onClick={() => void scanAndUpdate()}>
                  扫描缓存
                </button>
                <button className="btn primary" disabled={locked()} onClick={() => void updateMiHoYo(url)}>
                  {busy ? '更新中…' : '更新记录'}
                </button>
              </>
            )}
            <button className="btn" disabled={locked()} onClick={() => void doImport()}>
              导入
            </button>
            <button className="btn" disabled={locked()} onClick={() => void doExport()}>
              导出
            </button>
            {!isArknights && (
              <button className="btn ghost" onClick={() => void window.api.openExternal('https://uigf.org/zh/standards/uigf.html')}>
                UIGF 格式
              </button>
            )}
            <button className="btn ghost" disabled={locked()} onClick={() => void doClear()}>
              清空
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
          <div className="panel-title">各卡池（独立计算）</div>
          <Switch
            checked={showSecond}
            label="显示次高品级"
            onChange={(value) => void window.api.setGachaShowSecond(entry.id, value)}
          />
        </div>

        {stats && stats.pools.length === 0 ? (
          <div className="panel">
            <div className="empty">
              <div className="empty-icon">✦</div>
              <div className="empty-title">暂无记录</div>
              <div>{isArknights ? '点击「登录鹰角账号并获取记录」' : '点击「更新记录」获取抽卡数据'}</div>
            </div>
          </div>
        ) : (
          <div className="pools">
            {stats?.pools.map((pool) => {
              return (
                <div className="pool-col" key={pool.group}>
                  <div className="pool-col-head">
                    <div className="pool-col-name">{pool.bannerName}</div>
                    <div className="pool-col-count">{pool.uid ? `UID ${pool.uid}` : '账号未记录'} · {pool.count} 抽</div>
                  </div>

                  <div className="pool-pity">
                    <div className="pool-pity-line">
                      <span className="pp-tier">最高 {displayRank(entry.addonId, pool.topRank)}</span>
                      <span className="pp-val">{pool.pityKnown ? `已 ${pool.topPity} 抽未出` : '缺少历史信息'}</span>
                    </div>
                    {showSecond && pool.secondRank != null && (
                      <div className="pool-pity-line">
                        <span className="pp-tier">
                          次高 {displayRank(entry.addonId, pool.secondRank)}
                        </span>
                        <span className="pp-val">{pool.pityKnown ? `已 ${pool.secondPity ?? 0} 抽未出` : '缺少历史信息'}</span>
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
      if (active) setError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => { active = false }
  }, [appId, pool.group, showSecond, offset, revision])

  return (
    <div className="pool-records">
      {error && <div className="pool-empty">{error}</div>}
      {page?.records.map((record) => (
        <div className="pool-row" key={record.id}>
          <span className={`rank ${rankClass(record.rankType, pool.topRank)}`}>
            {displayRank(pool.game, record.rankType)}
          </span>
          <span className="pool-row-name">{record.itemName || record.itemId}</span>
          <span className="pool-row-pity">{record.pityAtPull ?? '—'}</span>
        </div>
      ))}
      {page?.matched === 0 && <div className="pool-empty">无符合品级的记录</div>}
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
