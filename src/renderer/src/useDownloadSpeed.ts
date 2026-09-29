import { useEffect, useRef, useState } from 'react'
import type { UpdateStatus } from '@shared/types'

/**
 * Download speed (bytes/second) smoothed from successive progress samples.
 * Returns 0 whenever no download is in progress.
 */
export function useDownloadSpeed(status: UpdateStatus | null): number {
  const lastRef = useRef<{ bytes: number; t: number } | null>(null)
  const [speed, setSpeed] = useState(0)

  useEffect(() => {
    if (!status || status.phase !== 'downloading') {
      lastRef.current = null
      setSpeed(0)
      return
    }
    const now = Date.now()
    const bytes = status.downloadedBytes
    const last = lastRef.current
    if (last && now > last.t) {
      const instant = Math.max(0, (bytes - last.bytes) / ((now - last.t) / 1000))
      setSpeed((prev) => (prev > 0 ? prev * 0.6 + instant * 0.4 : instant))
    }
    lastRef.current = { bytes, t: now }
  }, [status])

  return speed
}
