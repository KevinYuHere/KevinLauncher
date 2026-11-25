/** Dimensions which can be trusted without decoding a full raster. For JPEGs
 * with EXIF, use the decoder's oriented dimensions instead. */
export function imageHeaderSize(data: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const size = (width: number, height: number) => width > 0 && height > 0 ? { width, height } : null
  if (data.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a &&
      view.getUint32(12) === 0x49484452) {
    return size(view.getUint32(16), view.getUint32(20))
  }
  if (data[0] !== 0xff || data[1] !== 0xd8) return null
  for (let i = 2; i + 8 < data.length && data[i] === 0xff;) {
    const marker = data[i + 1]
    if (marker === 0xff) { i++; continue }
    if (marker === 0xe1 || marker === 0xda) return null
    const length = view.getUint16(i + 2)
    if (length < 2) return null
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return null
      return size(view.getUint16(i + 7), view.getUint16(i + 5))
    }
    i += length + 2
  }
  return null
}
