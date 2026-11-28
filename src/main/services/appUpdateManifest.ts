import type { AppUpdateCompatibility } from '@shared/types'

/** Optional delta that may only be applied to one exact installed version. */
export interface UpdateManifestDelta {
  fromVersion: string
  name: string
  size: number
  sha256: string
}

/** Release metadata needed to choose and verify the upgrade artifact. */
export interface UpdateManifest {
  version: string
  electron: string
  appSize: number
  payloadSize: number
  payloadSha256: string
  installerSize: number
  installerUnpackedSize?: number
  installerName: string | null
  installerSha256: string | null
  notes?: string
  compatibility?: AppUpdateCompatibility
  critical: boolean
  /** Smaller transfer for exactly `fromVersion`; the full payload stays the fallback. */
  delta?: UpdateManifestDelta
}

/** Metadata published next to a verified, installer-only Beta release. */
export interface BetaVerification {
  version: string
  installer: string
  size: number
  sha256: string
}

/** Versions become installation directory names as well as release tags. */
export const SAFE_VERSION = /^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/
export const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
/** Canonical public Beta tag (`x.y.z-beta.N`, no leading zeroes). */
export const BETA_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta\.[1-9]\d*$/

export function isBetaVersion(value: unknown): value is string {
  return typeof value === 'string' && BETA_VERSION.test(value)
}

export function payloadAssetName(version: string): string {
  return `KevinLauncher-${version}-app.zip`
}

export function installerAssetName(version: string): string {
  return `KevinLauncher-Installer-${version}.exe`
}

/** Canonical name of the delta whose only valid baseline is `fromVersion`. */
export function deltaAssetName(fromVersion: string, toVersion: string): string {
  return `KevinLauncher-${fromVersion}-to-${toVersion}-delta.json.gz`
}

export function isPositiveFileSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f]{64}$/i.test(value)
}

export function matchesUpdateTransfer(
  status: number, headers: Pick<Headers, 'get'>, bytes: number,
  range?: { start: number; end: number; size: number }
): boolean {
  const location = range ? `bytes ${range.start}-${range.end - 1}/${range.size}` : null
  const length = headers.get('content-length')
  return status === (range ? 206 : 200) && headers.get('content-range') === location &&
    (length === null || Number(length) === bytes)
}

export function isRuntimeVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
}

export function parseUpdateCompatibility(value: unknown): AppUpdateCompatibility | undefined {
  if (value == null) return undefined
  const { shellProtocol, installProtocol, dataSchema, hostSha256 } = value as Partial<AppUpdateCompatibility>
  if (!isPositiveFileSize(shellProtocol) || !isPositiveFileSize(installProtocol) ||
      !isPositiveFileSize(dataSchema) || !isSha256(hostSha256)) throw new Error('更新兼容信息无效')
  return { shellProtocol, installProtocol, dataSchema, hostSha256: hostSha256.toLowerCase() }
}

export function isHotUpdateCompatible(
  current: AppUpdateCompatibility | undefined,
  target: AppUpdateCompatibility | undefined
): boolean {
  return !!current && !!target && current.shellProtocol >= 2 && current.shellProtocol === target.shellProtocol &&
    current.installProtocol === target.installProtocol && current.dataSchema === target.dataSchema &&
    current.hostSha256 === target.hostSha256
}

/**
 * Deltas are tied to one exact installed version. Anything else (ranges, a
 * noncanonical asset name, missing size/hash) would make us download an
 * unverifiable or inapplicable artifact, so the whole descriptor is rejected.
 */
function parseUpdateDelta(value: unknown, version: string): UpdateManifestDelta | undefined {
  if (value == null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('更新清单差量格式无效')
  const { fromVersion, name, size, sha256 } = value as Record<string, unknown>
  if (typeof fromVersion !== 'string' || !SAFE_VERSION.test(fromVersion) || fromVersion === version ||
      name !== deltaAssetName(fromVersion, version) || !isPositiveFileSize(size) || !isSha256(sha256)) {
    throw new Error('更新清单缺少有效的差量来源、名称、大小或校验值')
  }
  return { fromVersion, name, size, sha256: sha256.toLowerCase() }
}

export function parseUpdateManifest(raw: string, expectedVersion?: string): UpdateManifest {
  const data: unknown = JSON.parse(raw)
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('更新清单格式无效')
  const { version, electron, appSize, payloadSize, payloadSha256, installerSize, installerName,
    installerSha256, installerUnpackedSize, notes, critical, compatibility, delta } =
    data as Record<string, unknown>
  if (typeof version !== 'string' || !SAFE_VERSION.test(version) ||
      (expectedVersion !== undefined && version !== expectedVersion) ||
      !isRuntimeVersion(electron) || !isPositiveFileSize(appSize) ||
      !isPositiveFileSize(payloadSize) || !isSha256(payloadSha256)) {
    throw new Error('更新清单缺少匹配的版本、运行库或应用包校验信息')
  }
  const parsedDelta = parseUpdateDelta(delta, version)
  const optional = {
    notes: typeof notes === 'string' ? notes.trim() : undefined, critical: critical === true,
    compatibility: parseUpdateCompatibility(compatibility),
    ...(parsedDelta ? { delta: parsedDelta } : {})
  }
  if (installerSize == null || installerSize === 0) {
    if (installerName != null || installerSha256 != null) throw new Error('更新清单安装程序信息不完整')
    return {
      version, electron, appSize, payloadSize, payloadSha256: payloadSha256.toLowerCase(),
      installerSize: 0, installerName: null, installerSha256: null, ...optional
    }
  }
  if (!isPositiveFileSize(installerSize) || installerName !== installerAssetName(version) ||
      !isSha256(installerSha256) ||
      installerUnpackedSize !== undefined && !isPositiveFileSize(installerUnpackedSize)) {
    throw new Error('更新清单缺少匹配的安装程序校验信息')
  }
  return {
    version, electron, appSize, payloadSize, payloadSha256: payloadSha256.toLowerCase(),
    installerSize, installerUnpackedSize: installerUnpackedSize as number | undefined,
    installerName, installerSha256: installerSha256.toLowerCase(), ...optional
  }
}

/**
 * Parse the locally generated `beta-verification.json` that a verified Beta
 * publishes next to its installer. Beta releases are installer-only, so the
 * release-level permission checks are part of the metadata we accept.
 */
export function parseBetaVerification(raw: string, expectedVersion?: string): BetaVerification {
  const data: unknown = JSON.parse(raw)
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Beta 验证清单格式无效')
  const { version, installer, size, sha256, installerMode, entryMode, runtimeMode } =
    data as Record<string, unknown>
  if (typeof version !== 'string' || !isBetaVersion(version) ||
      (expectedVersion !== undefined && version !== expectedVersion) ||
      installer !== installerAssetName(version) ||
      !isPositiveFileSize(size) || !isSha256(sha256) ||
      installerMode !== 'requireAdministrator' || entryMode !== 'requireAdministrator' ||
      runtimeMode !== 'asInvoker') {
    throw new Error('Beta 验证清单缺少匹配的版本、安装包、大小、校验值或执行权限')
  }
  return { version, installer, size, sha256: sha256.toLowerCase() }
}
