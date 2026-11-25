import type { GachaGame, GachaRecordPage, GachaStats } from '@shared/types'

export type IndexQuery =
  | { type: 'stats'; game?: GachaGame }
  | { type: 'page'; group: string; showSecond: boolean; offset: number; limit: number }

export interface IndexRequest {
  id: number
  file: string
  revision: number
  appId: string
  query: IndexQuery
}

export type IndexResponse =
  | { id: number; value: GachaStats | GachaRecordPage }
  | { id: number; error: string }
