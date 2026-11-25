const DATA_ERROR_CODES = [
  'READ_FAILED', 'SAVE_FAILED', 'INVALID_CONFIG', 'UNSUPPORTED_CONFIG', 'NOT_FOUND',
  'DATA_MOVED', 'RECOVERY_REQUIRED'
] as const

export type DataErrorCode = (typeof DATA_ERROR_CODES)[number]

export class DataError extends Error {
  constructor(readonly code: DataErrorCode, message: string, cause?: unknown) {
    // Electron IPC preserves the error message when it cannot preserve custom fields.
    super(`[${code}] ${message}`, { cause })
  }
}

export function dataErrorDetails(error: unknown): { code: DataErrorCode; message: string } | null {
  const match = /\[([A-Z_]+)\]\s*(.*)/s.exec(error instanceof Error ? error.message : String(error))
  if (!match || !(DATA_ERROR_CODES as readonly string[]).includes(match[1])) return null
  return { code: match[1] as DataErrorCode, message: match[2] }
}
