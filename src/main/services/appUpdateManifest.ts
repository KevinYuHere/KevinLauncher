/** Release metadata needed to choose and verify the upgrade artifact. */
export interface UpdateManifest {
  version: string
  electron: string
  appSize: number
  payloadSize: number
  payloadSha256: string
  installerSize: number
  installerName: string | null
  installerSha256: string | null
  notes?: string
  critical: boolean
}

/** Versions become installation directory names as well as release tags. */
export const SAFE_VERSION = /^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/

export function payloadAssetName(version: string): string {
  return `KevinLauncher-${version}-app.zip`
}

export function installerAssetName(version: string): string {
  return `KevinLauncher-Installer-${version}.exe`
}

export function isPositiveFileSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f]{64}$/i.test(value)
}

export function isRuntimeVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
}

export function parseUpdateManifest(raw: string, expectedVersion?: string): UpdateManifest {
  const data: unknown = JSON.parse(raw)
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('更新清单格式无效')
  const { version, electron, appSize, payloadSize, payloadSha256, installerSize, installerName,
    installerSha256, notes, critical } = data as Record<string, unknown>
  if (typeof version !== 'string' || !SAFE_VERSION.test(version) ||
      (expectedVersion !== undefined && version !== expectedVersion) ||
      !isRuntimeVersion(electron) || !isPositiveFileSize(appSize) ||
      !isPositiveFileSize(payloadSize) || !isSha256(payloadSha256)) {
    throw new Error('更新清单缺少匹配的版本、运行库或应用包校验信息')
  }
  const optional = { notes: typeof notes === 'string' ? notes.trim() : undefined, critical: critical === true }
  if (installerSize == null || installerSize === 0) {
    if (installerName != null || installerSha256 != null) throw new Error('更新清单安装程序信息不完整')
    return {
      version, electron, appSize, payloadSize, payloadSha256: payloadSha256.toLowerCase(),
      installerSize: 0, installerName: null, installerSha256: null, ...optional
    }
  }
  if (!isPositiveFileSize(installerSize) || installerName !== installerAssetName(version) ||
      !isSha256(installerSha256)) {
    throw new Error('更新清单缺少匹配的安装程序校验信息')
  }
  return {
    version, electron, appSize, payloadSize, payloadSha256: payloadSha256.toLowerCase(),
    installerSize, installerName, installerSha256: installerSha256.toLowerCase(), ...optional
  }
}
