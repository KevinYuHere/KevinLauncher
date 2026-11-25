// Module worker that turns a full-size screenshot into a small JPEG thumbnail
// off the main thread. The renderer reads the file into an ArrayBuffer and
// transfers it here; the resulting Blob is sent back (also transferred).
interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

const scope = self as unknown as WorkerScope

const THUMB_WIDTH = 480

interface Task {
  path: string
  buffer: ArrayBuffer
}

scope.onmessage = async (event: MessageEvent): Promise<void> => {
  const { path, buffer } = event.data as Task
  try {
    const blob = new Blob([buffer])
    const bitmap = await createImageBitmap(blob, {
      resizeWidth: THUMB_WIDTH,
      resizeQuality: 'medium'
    })
    const width = bitmap.width
    const height = bitmap.height
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
    scope.postMessage({ path, blob: out, width, height })
  } catch (error) {
    scope.postMessage({ path, error: String(error) })
  }
}
