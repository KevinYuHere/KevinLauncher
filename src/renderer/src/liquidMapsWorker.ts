import { buildBezelProfile, buildDisplacementBytes, buildSpecularBytes, DEFAULT_BEZEL_HEIGHT_FN } from './liquidGlass'
import type { liquidMapInputs, LiquidMaps } from './liquidFilter'

type Input = ReturnType<typeof liquidMapInputs>
type MapImage = { href: string; maxDisp: number }
const MAX_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 192
const images = new Map<string, MapImage>()
let cachedBytes = 0
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; input: Input }>) => void) | null
  postMessage(message: unknown): void
}

async function getImage(
  key: string, width: number, height: number, generate: () => { rgba: Uint8ClampedArray; maxDisp: number }
): Promise<MapImage> {
  const cached = images.get(key)
  if (cached) {
    images.delete(key)
    images.set(key, cached)
    return cached
  }
  const { rgba, maxDisp } = generate()
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas context for liquid glass')
  const pixels = ctx.createImageData(width, height)
  pixels.data.set(rgba)
  ctx.putImageData(pixels, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const href = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  const image = { href, maxDisp }
  images.set(key, image)
  cachedBytes += href.length * 2
  while (images.size > MAX_ENTRIES || cachedBytes > MAX_BYTES) {
    const [oldKey, oldImage] = images.entries().next().value!
    images.delete(oldKey)
    cachedBytes -= oldImage.href.length * 2
  }
  return image
}

async function prepare({ id, input }: { id: number; input: Input }): Promise<void> {
  try {
    const { width, height, radius, glassThickness, bezelWidth, refractiveIndex, angle, dpr } = input
    const w = Math.max(1, Math.round(width * dpr))
    const h = Math.max(1, Math.round(height * dpr))
    const disp = await getImage(input.displacementKey, w, h, () => {
      const profile = buildBezelProfile(glassThickness, bezelWidth, DEFAULT_BEZEL_HEIGHT_FN, refractiveIndex)
      let maxDisp = 1e-6
      for (const value of profile) maxDisp = Math.max(maxDisp, Math.abs(value))
      return { rgba: buildDisplacementBytes(width, height, radius, bezelWidth, maxDisp, profile, dpr), maxDisp }
    })
    const spec = await getImage(input.specularKey, w, h, () => ({
      rgba: buildSpecularBytes(width, height, radius, Math.max(8, radius * 1.1), angle, dpr),
      maxDisp: 0
    }))
    const maps: LiquidMaps = { dispHref: disp.href, specHref: spec.href, maxDisp: disp.maxDisp }
    scope.postMessage({ id, maps })
  } catch {
    scope.postMessage({ id })
  }
}

let tail = Promise.resolve()
scope.onmessage = ({ data }): void => { tail = tail.then(() => prepare(data)) }
