import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { AppEntry, PlayTimeDay, PlayTimeTotals } from '@shared/types'

interface PlayTimeViewProps {
  entry: AppEntry
  onBack: () => void
}

const DAYS = 371
const GAP = 3

function formatHours(sec: number): string {
  const hours = sec / 3600
  if (hours >= 1) return `${hours.toFixed(1)} 小时`
  return `${Math.max(0, Math.round(sec / 60))} 分钟`
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  const value = match ? parseInt(match[1], 16) : 0x3778e5
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

export default function PlayTimeView({ entry, onBack }: PlayTimeViewProps): ReactElement {
  const [totals, setTotals] = useState<PlayTimeTotals | null>(null)
  const [selected, setSelected] = useState<PlayTimeDay | null>(null)
  const [cell, setCell] = useState(13)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.api.playTimeSummary(entry.id, DAYS).then(setTotals)
  }, [entry.id])

  const daily = totals?.daily ?? []
  const maxSec = Math.max(1, ...daily.map((d) => d.sec))
  const base = hexToRgb(entry.themeColor ?? '#3778e5')

  const levelOf = (sec: number): number => {
    if (sec <= 0) return 0
    const ratio = sec / maxSec
    if (ratio > 0.75) return 4
    if (ratio > 0.5) return 3
    if (ratio > 0.25) return 2
    return 1
  }

  const colorOf = (level: number): string => {
    if (level === 0) return 'rgba(255, 255, 255, 0.06)'
    const alpha = [0, 0.28, 0.5, 0.72, 1][level]
    return `rgba(${base.r}, ${base.g}, ${base.b}, ${alpha})`
  }

  const cells = useMemo<(PlayTimeDay | null)[]>(() => {
    const list: (PlayTimeDay | null)[] = []
    if (daily.length === 0) return list
    const first = new Date(`${daily[0].date}T00:00:00`)
    for (let i = 0; i < first.getDay(); i++) list.push(null)
    for (const day of daily) list.push(day)
    return list
  }, [daily])

  // Size the cells so all weeks fit the page width (only scroll if too narrow).
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const compute = (): void => {
      const cols = Math.max(1, Math.ceil(cells.length / 7))
      const width = el.clientWidth
      const size = Math.floor((width - (cols - 1) * GAP) / cols)
      setCell(Math.max(8, Math.min(16, size)))
    }
    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(el)
    return () => observer.disconnect()
  }, [cells.length])

  const heatmapStyle = { '--hm-cell': `${cell}px`, '--hm-gap': `${GAP}px` } as CSSProperties

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">使用时长 · {entry.name}</h1>
          <p className="page-subtitle">
            {totals && totals.totalSec > 0 ? `累计 ${formatHours(totals.totalSec)}` : '暂无记录'}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={onBack}>
            返回主页
          </button>
        </div>
      </div>

      <div className="page-body">
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-value">{formatHours(totals?.totalSec ?? 0)}</div>
            <div className="stat-label">总时长</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{formatHours(totals?.todaySec ?? 0)}</div>
            <div className="stat-label">今日</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{formatHours(totals?.weekSec ?? 0)}</div>
            <div className="stat-label">近 7 天</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{formatHours(totals?.monthSec ?? 0)}</div>
            <div className="stat-label">近 30 天</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">每日使用热力图（近一年）</div>
          </div>
          <div className="panel-body">
            <div className="heatmap-wrap" ref={wrapRef}>
              <div className="heatmap" style={heatmapStyle}>
                {cells.map((day, index) =>
                  day ? (
                    <div
                      key={index}
                      className={`hm-cell${selected?.date === day.date ? ' selected' : ''}`}
                      style={{ background: colorOf(levelOf(day.sec)) }}
                      onMouseEnter={() => setSelected(day)}
                    />
                  ) : (
                    <div key={index} className="hm-cell empty" />
                  )
                )}
              </div>
            </div>
            <div className="hm-selected">
              {selected ? (
                <>
                  日期 <b>{selected.date}</b> · 使用 <b>{formatHours(selected.sec)}</b>
                </>
              ) : (
                '将鼠标移到方格上查看当日日期与使用时长'
              )}
            </div>
            <div className="hm-legend">
              <span>少</span>
              {[0, 1, 2, 3, 4].map((level) => (
                <span key={level} className="hm-cell" style={{ background: colorOf(level) }} />
              ))}
              <span>多</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
