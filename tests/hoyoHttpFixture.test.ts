import { expect, it } from 'vitest'
import { startHoyoHttpFixture } from './fixtures/hoyoHttpFixture'

it('provides deterministic offline CDN responses and captures resume ranges', async () => {
  const fixture = await startHoyoHttpFixture()
  try {
    fixture.route('/patch', { status: 503 }, { body: '0123456789' })
    const url = fixture.url + '/patch'
    const init = { headers: { range: 'bytes=4-7' } }
    expect((await fetch(url, init)).status).toBe(503)
    const response = await fetch(url, init)
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 4-7/10')
    expect(await response.text()).toBe('4567')
    expect(fixture.requests).toEqual([
      { method: 'GET', path: '/patch', range: 'bytes=4-7' },
      { method: 'GET', path: '/patch', range: 'bytes=4-7' }
    ])
  } finally {
    await fixture.close()
  }
})

it('leaves a reproducible prefix before a held HTTP response is cancelled', async () => {
  const fixture = await startHoyoHttpFixture()
  try {
    fixture.route('/paused', { body: '12345678', interrupt: { after: 4, mode: 'wait' } })
    const controller = new AbortController()
    const response = await fetch(fixture.url + '/paused', { signal: controller.signal })
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(Buffer.from(first.value!).toString()).toBe('1234')
    controller.abort()
    await expect(reader.read()).rejects.toThrow()
  } finally {
    await fixture.close()
  }
})
