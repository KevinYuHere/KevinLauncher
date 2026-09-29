import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { AddonDescriptor, AppEntry, GachaRecord, GachaStats } from '@shared/types'
import { displayRank, rankClass } from '../format'
import { confirm } from './confirm'

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
  const [records, setRecords] = useState<GachaRecord[]>([])
  const [stats, setStats] = useState<GachaStats | null>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [showSecond, setShowSecond] = useState(true)

  const refresh = useCallback(async (): Promise<void> => {
    setRecords(await window.api.gachaList(entry.id))
    setStats(await window.api.gachaStats(entry.id))
  }, [entry.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const updateMiHoYo = useCallback(
    async (source: string): Promise<void> => {
      if (!source.trim()) {
        onToast('请先获取或粘贴抽卡链接')
        return
      }
      setBusy(true)
      try {
        const result = await window.api.gachaUpdateMiHoYo(entry.id, source.trim())
        onToast(`更新完成：新增 ${result.added} 条，共 ${result.total} 条`)
        await refresh()
      } catch (error) {
        onToast(`更新失败：${(error as Error).message}`)
      } finally {
        setBusy(false)
      }
    },
    [entry.id, onToast, refresh]
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
    } finally {
      setBusy(false)
    }
  }, [entry.id, onToast, updateMiHoYo])

  const loginArknights = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.gachaLoginArknights(entry.id)
      onToast(`更新完成：新增 ${result.added} 条，共 ${result.total} 条`)
      await refresh()
    } catch (error) {
      onToast(`获取失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [entry.id, onToast, refresh])

  const doExport = useCallback(async (): Promise<void> => {
    const path = await window.api.gachaExport(entry.id)
    if (path) onToast('已导出到 ' + path)
  }, [entry.id, onToast])

  const doImport = useCallback(async (): Promise<void> => {
    const added = await window.api.gachaImport(entry.id)
    onToast(`导入完成：新增 ${added} 条`)
    await refresh()
  }, [entry.id, onToast, refresh])

  const doClear = useCallback(async (): Promise<void> => {
    if (!(await confirm('确定清空该应用的抽卡记录吗？'))) return
    await window.api.gachaClear(entry.id)
    await refresh()
    onToast('已清空')
  }, [entry.id, onToast, refresh])

  const topRank = stats?.topRank ?? 5
  const secondRank = stats?.secondRank ?? null
  const minRank = showSecond ? secondRank ?? Math.max(0, topRank - 1) : topRank

  const byGroup = useMemo(() => {
    const map = new Map<string, GachaRecord[]>()
    for (const record of records) {
      if (record.rankType < minRank) continue
      const group = record.group ?? record.gachaType
      const list = map.get(group)
      if (list) list.push(record)
      else map.set(group, [record])
    }
    return map
  }, [records, minRank])

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{entry.name} · 抽卡记录</h1>
          <p className="page-subtitle">
            {stats && stats.total > 0 ? `共 ${stats.total} 条记录` : '尚未获取记录'}
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
                <input
                  className="input"
                  style={{ flex: 1, minWidth: 280 }}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="抽卡链接（含 authkey），或点「扫描缓存」自动获取"
                />
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
          <label className="switch">
            <input
              type="checkbox"
              checked={showSecond}
              onChange={(e) => setShowSecond(e.target.checked)}
            />
            <span>显示次高品级</span>
          </label>
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
              const poolRecords = byGroup.get(pool.group) ?? []
              return (
                <div className="pool-col" key={pool.group}>
                  <div className="pool-col-head">
                    <div className="pool-col-name">{pool.bannerName}</div>
                    <div className="pool-col-count">{pool.count} 抽</div>
                  </div>

                  <div className="pool-pity">
                    <div className="pool-pity-line">
                      <span className="pp-tier">最高 {displayRank(entry.addonId, pool.topRank)}</span>
                      <span className="pp-val">已 {pool.topPity} 抽未出</span>
                    </div>
                    {showSecond && pool.secondRank != null && (
                      <div className="pool-pity-line">
                        <span className="pp-tier">
                          次高 {displayRank(entry.addonId, pool.secondRank)}
                        </span>
                        <span className="pp-val">已 {pool.secondPity ?? 0} 抽未出</span>
                      </div>
                    )}
                  </div>

                  <div className="pool-records">
                    {poolRecords.length === 0 ? (
                      <div className="pool-empty">无符合品级的记录</div>
                    ) : (
                      poolRecords.map((record) => (
                        <div className="pool-row" key={record.id}>
                          <span className={`rank ${rankClass(record.rankType, topRank)}`}>
                            {displayRank(entry.addonId, record.rankType)}
                          </span>
                          <span className="pool-row-name">{record.itemName}</span>
                          <span className="pool-row-pity">
                            {record.pityAtPull != null ? `${record.pityAtPull}` : '—'}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
