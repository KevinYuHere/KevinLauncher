import { useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import Ring from './Ring'
import GlassPopup from './GlassPopup'
import Icon from './Icon'
import { useLongPress } from '../drag/useLongPress'

/** Button colour tone: plain (white) / update (theme) / stop (red). */
export type DownloadTone = 'plain' | 'update' | 'stop'
/** Ring colour: pre-download = theme-coloured, update = white. */
export type RingTone = 'pre' | 'update'

interface DownloadButtonProps {
  /** Button label (启动 / 开始更新 / 停止 / 45% / 已暂停). */
  label: ReactNode
  onButtonClick: () => void
  tone?: DownloadTone
  /**
   * Progress 0…1 while a job (pre-download or update) is running; `null` when
   * idle. With `idleIcon` and `null` the cap circle shows the idle icon.
   */
  progress?: number | null
  /** Job paused → the ring shows a play (resume) icon instead of a pause one. */
  paused?: boolean
  ringTone?: RingTone
  /** Idle cap-circle icon (e.g. a pre-download is available but not started). */
  idleIcon?: ReactNode
  /** Download details shown above the ring on hover while a job is active. */
  popup?: ReactNode
  /** Bounds the popup stays within (e.g. the home stage). */
  boundsRef?: RefObject<HTMLElement>
  /** Long-press handler (opens the special launch-method picker). */
  onLongPress?: (rect: DOMRect) => void
  /** Click on the cap circle (update / pre-download control); falls back to onButtonClick. */
  onCircleClick?: () => void
  /** Highlighted as the selected choice of the launch drawer (theme colour). */
  selected?: boolean
}

/**
 * The launch button + its cap progress circle, shared by game updates and
 * pre-downloads so both look and behave identically: the ring shows real
 * progress with a pause/play icon inside, the button keeps a fixed width, and
 * hovering the ring reveals the same speed / percentage popup.
 */
export default function DownloadButton({
  label,
  onButtonClick,
  tone = 'plain',
  progress = null,
  paused = false,
  ringTone = 'pre',
  idleIcon,
  popup,
  boundsRef,
  onLongPress,
  onCircleClick,
  selected
}: DownloadButtonProps): ReactElement {
  const circleRef = useRef<HTMLButtonElement>(null)
  const [hover, setHover] = useState(false)
  const active = progress != null
  const hasCircle = active || !!idleIcon
  const longPress = useLongPress((rect) => onLongPress?.(rect))

  return (
    <span className="start-wrap">
      <button
        className={`start-btn${tone !== 'plain' ? ` ${tone}` : ''}${hasCircle ? ' has-circle' : ''}${selected ? ' selected' : ''}`}
        onPointerDown={onLongPress ? longPress.onPointerDown : undefined}
        onClick={() => {
          if (longPress.consumeClick()) return
          onButtonClick()
        }}
      >
        {label}
      </button>

      {hasCircle && (
        <div
          className="pre-wrap"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          <button
            ref={circleRef}
            className={`pre-circle${ringTone === 'update' ? ' update-circle' : ''}`}
            onClick={onCircleClick ?? onButtonClick}
            title={active ? '点击暂停 / 继续' : '下载'}
          >
            {active ? (
              <>
                <Ring value={progress} />
                <span className="pre-state">
                  <Icon name={paused ? 'play' : 'pause'} size={16} />
                </span>
              </>
            ) : (
              <>
                <svg className="pre-ring" width={36} height={36} viewBox="0 0 36 36">
                  <circle
                    cx={18}
                    cy={18}
                    r={16.5}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={3}
                  />
                </svg>
                <span className="pre-icon">{idleIcon}</span>
              </>
            )}
          </button>

          {popup && (
            <GlassPopup
              anchorRef={circleRef}
              boundsRef={boundsRef}
              visible={hover && active}
              className="dl-pop-glass"
            >
              {popup}
            </GlassPopup>
          )}
        </div>
      )}
    </span>
  )
}
