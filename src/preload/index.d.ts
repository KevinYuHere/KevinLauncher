import type { KevinApi } from '@shared/types'

declare global {
  interface Window {
    api: KevinApi
  }
}

export {}
