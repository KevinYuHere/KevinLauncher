import type { ReactElement, ReactNode } from 'react'

export interface KevinHudRowProps {
  name: string
  desc?: string
  action?: ReactNode
}

/** Shared setting row for every KEVIN HUD section, including the copy panel. */
export default function KevinHudRow({
  name,
  desc,
  action
}: KevinHudRowProps): ReactElement {
  return (
    <div className="settings-row">
      <div className="settings-main">
        <div className="settings-name">{name}</div>
        {desc && <div className="settings-desc">{desc}</div>}
      </div>
      {action && <div className="settings-action">{action}</div>}
    </div>
  )
}
