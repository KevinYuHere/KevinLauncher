import { useEffect, useRef, type ReactElement } from 'react'
import type { LaunchEffect } from '@shared/types'
import { captureWallpaperBackground } from '../wallpaperTexture'
import WallpaperShatter from './WallpaperShatter'
import WallpaperBurst from './WallpaperBurst'
import MitiaNova from './MitiaNova'

interface LaunchTransitionProps {
  /** Effect + a nonce that changes on each launch (null = idle). */
  trigger: {
    effect: LaunchEffect
    key: number
    originX?: number
    originY?: number
  } | null
  onDone: () => void
}

// Shader modes: 0 shockwave, 1 melt, 2 glitch, 3 gravity.
// (gravity / shatter / nova are drawn by their own overlays, never by the shader.)
const MODE: Record<Exclude<LaunchEffect, 'none'>, number> = {
  shockwave: 0,
  melt: 1,
  glitch: 2,
  gravity: 3,
  shatter: 4,
  nova: 5
}

const VS = `
  attribute vec2 aPos; varying vec2 vUv;
  void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`

const FS = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex; uniform vec2 uRes; uniform float uTime;
  uniform vec2 uOrigin; uniform float uProgress; uniform int uMode; uniform vec3 uTheme;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float dist2(vec2 uv){ vec2 d = uv-uOrigin; d.x *= uRes.x/uRes.y; return length(d); }
  vec3 tex(vec2 uv){ return texture2D(uTex, vec2(uv.x, 1.0-uv.y)).rgb; }
  void main(){
    vec2 uv = vUv; float p = clamp(uProgress,0.0,1.0);
    float d = dist2(uv);
    vec2 dir = normalize((uv-uOrigin)*vec2(uRes.x/uRes.y,1.0)+vec2(1e-5));
    vec3 col = tex(uv);
    if (uMode == 0) {
      float R = p*1.6, w = 0.16*(1.0-p)+0.05, e = (d-R)/w;
      float lens = e*exp(-e*e)*2.3, amp = 0.075*(1.0-p);
      float pop = exp(-pow((p-0.06)/0.10,2.0));
      vec2 zoomed = uOrigin + (uv-uOrigin)*(1.0-0.055*pop);
      vec2 off = dir*lens*amp;
      float ca = 0.020*exp(-e*e)*(1.0-p) + 0.005*pop;
      vec3 c;
      c.r = tex(zoomed-off*1.08-dir*ca).r; c.g = tex(zoomed-off).g; c.b = tex(zoomed-off*0.92+dir*ca).b;
      col = c;
      float crest = exp(-e*e*2.2);
      vec3 rainbow = 0.5 + 0.5*cos(6.28318*(crest*0.7 + vec3(0.0,0.33,0.66)));
      col += vec3(1.0)*pow(crest,2.5)*0.95*(1.0-p);
      col += (rainbow-0.5)*crest*0.38*(1.0-p);
      for (int i=1;i<=2;i++){ float Ri=R*(1.0-0.18*float(i)); float ei=(d-Ri)/(w*1.4);
        col += vec3(0.75,0.85,1.0)*exp(-ei*ei*2.0)*(0.30/float(i))*(1.0-p); }
      vec2 o2 = uv-uOrigin; float ang = atan(o2.y,o2.x);
      float rays = pow(abs(cos(ang*3.0)),48.0) + pow(abs(cos(ang*3.0+1.047)),48.0);
      col += vec3(1.0)*rays*exp(-d*14.0)*(1.0-smoothstep(0.0,0.35,p))*1.25;
      col *= 1.0 - 0.25*crest;
    } else if (uMode == 1) {
      float melt = smoothstep(0.0,0.55,p); vec2 uvm = uv;
      uvm.x += sin(uv.y*13.0+uTime*2.4)*0.018*melt;
      uvm.y += cos(uv.x*10.0-uTime*1.8)*0.018*melt;
      uvm.y += 0.055*melt*smoothstep(0.0,0.75,uv.y);
      float bs = 0.055; vec2 bid = floor(uvm/bs);
      float rnd = hash(bid+floor(uTime*18.0));
      float corrupt = step(0.80,rnd)*smoothstep(0.18,0.50,p)*(1.0-smoothstep(0.50,0.85,p));
      uvm += (vec2(hash(bid+1.3),hash(bid+7.7))-0.5)*0.14*corrupt;
      float gy = floor(uv.y*30.0); float tend = hash(vec2(gy,floor(uTime*16.0)));
      uvm.x += (tend-0.5)*0.11*step(0.74,tend)*smoothstep(0.2,0.6,p)*(1.0-smoothstep(0.7,1.0,p));
      float ca = 0.004 + 0.030*smoothstep(0.2,1.0,p); vec3 c;
      c.r = tex(uvm+vec2(ca,ca*0.35)).r; c.g = tex(uvm).g; c.b = tex(uvm-vec2(ca,ca*0.35)).b;
      col = c * (0.9 + 0.1*sin(uv.y*uRes.y*1.5));
      float n = hash(uv*150.0)*0.55 + hash(uv*37.0)*0.45;
      float edge = smoothstep(0.0,1.0,p)*1.6;
      float diss = smoothstep(edge+0.30, edge-0.30, dist2(uv)+n*0.40);
      col = mix(col, uTheme*0.10 + vec3(0.015,0.018,0.03), diss);
    } else if (uMode == 2) {
      vec2 uvg = uv;
      float slice = floor(uv.y*42.0), r1 = hash(vec2(slice,floor(uTime*24.0)));
      uvg.x += (r1-0.5)*0.22*step(0.62,r1)*smoothstep(0.10,0.5,p)*(1.0-smoothstep(0.65,0.98,p));
      float bx=floor(uv.x*18.0), by=floor(uv.y*30.0), rb=hash(vec2(bx,by)+floor(uTime*20.0));
      float corrupt = step(0.86,rb)*smoothstep(0.15,0.5,p)*(1.0-smoothstep(0.6,0.95,p));
      uvg += (vec2(hash(vec2(bx,by)+3.1),hash(vec2(bx,by)+9.7))-0.5)*0.18*corrupt;
      float ca = 0.008 + 0.045*smoothstep(0.15,1.0,p); vec3 c;
      c.r = tex(uvg+vec2(ca,ca*0.5)).r; c.g = tex(uvg).g; c.b = tex(uvg-vec2(ca,ca*0.5)).b;
      col = c * (0.82 + 0.18*sin(uv.y*uRes.y*2.0));
      col += (hash(uv*300.0+uTime)-0.5)*0.10*smoothstep(0.2,0.6,p);
      float band = exp(-pow((uv.y-(1.0-fract(uTime*0.5)))/0.03,2.0));
      col += vec3(0.85,0.92,1.0)*band*0.16*smoothstep(0.1,0.4,p)*(1.0-smoothstep(0.7,1.0,p));
      float fl = step(0.9, hash(vec2(floor(uTime*30.0),5.0)))*smoothstep(0.15,0.5,p)*(1.0-smoothstep(0.6,0.95,p));
      col = mix(col, vec3(1.0)-col, fl*0.6);
      col = mix(col, uTheme, smoothstep(0.55,1.0,p)*0.30);
    } else if (uMode == 3) {
      // 引力奇点: the nucleus grows, its gravity spirals the whole wallpaper in.
      float pull = smoothstep(0.0, 0.86, p);
      vec2 d = (uv - uOrigin); d.x *= uRes.x / uRes.y;
      float dist = length(d);
      float ang = atan(d.y, d.x);
      float spin = (3.2 * p) / (0.18 + dist);
      mat2 rot = mat2(cos(spin), -sin(spin), sin(spin), cos(spin));
      vec2 suv = uOrigin + rot * (uv - uOrigin) * (1.0 - 0.86 * pull);
      float ca = 0.012 + 0.070 * pull;
      vec3 c;
      c.r = tex(suv + vec2(ca, 0.0)).r;
      c.g = tex(suv).g;
      c.b = tex(suv - vec2(ca, 0.0)).b;
      vec3 radial = vec3(0.0);
      for (int i = 1; i <= 6; i++) {
        float t = float(i) / 6.0 * 0.22 * pull;
        radial += tex(suv - (uv - uOrigin) * t);
      }
      c = mix(c, radial / 6.0, pull * 0.6);
      col = c * (1.0 - 0.62 * pull);
      float gap = smoothstep(0.42, 0.92, abs(cos(ang * 3.0 + uTime * 1.4)));
      float ringA = exp(-pow((dist - (0.10 + p * 0.52)) / 0.010, 2.0));
      float ringB = exp(-pow((dist - (0.34 + p * 0.78)) / 0.016, 2.0));
      float ringC = exp(-pow((dist - (0.58 + p * 0.92)) / 0.024, 2.0));
      vec3 glow = mix(uTheme, vec3(0.62, 0.90, 1.0), 0.55);
      col += glow * (ringA * 1.15 + ringB * 0.55 + ringC * 0.30) * (0.35 + 0.65 * gap) * (1.0 - smoothstep(0.78, 1.0, p));
      float arcs = pow(abs(cos(ang * 9.0 + sin(dist * 18.0 + uTime * 2.6) * 2.0)), 32.0);
      col += vec3(0.72, 0.92, 1.0) * arcs * exp(-dist * 5.0) * (1.0 - p) * 0.9;
      float stars = step(0.9985, hash(floor(uv * 420.0) + floor(uTime * 7.0)));
      col += vec3(0.85, 0.96, 1.0) * stars * (1.0 - p) * 0.85;
      float coreR = 0.016 + p * p * 1.08;
      float core = smoothstep(coreR, coreR - 0.018, dist);
      vec3 inner = mix(vec3(0.52, 0.90, 1.0), uTheme * 1.35, 0.35);
      float plasma = 0.5 + 0.5 * sin(ang * 8.0 + dist * 52.0 - uTime * 5.0);
      float spokes = pow(abs(cos(ang * 6.0 + dist * 26.0 + uTime * 1.5)), 18.0);
      inner *= 0.68 + 0.32 * plasma;
      inner += vec3(0.72, 0.94, 1.0) * spokes * 0.42;
      inner = mix(inner, vec3(1.0), smoothstep(coreR * 0.58, 0.0, dist));
      float rim = exp(-pow((dist - coreR) / 0.011, 2.0)) * (0.62 + 0.38 * cos(ang * 6.0 + uTime * 3.6));
      float hexRim = exp(-pow((dist - coreR * 1.22) / 0.008, 2.0)) * (0.55 + 0.45 * cos(ang * 3.0 + uTime * 2.2));
      col = mix(col, inner, core);
      col += mix(vec3(0.62, 0.92, 1.0), vec3(1.0), 0.45) * hexRim * 1.55;
      col += mix(uTheme, vec3(1.0), 0.68) * rim * 1.6;
      col += vec3(1.0) * exp(-dist * dist / max(0.00001, coreR * coreR * 0.20)) * 1.35;
      col += vec3(1.0) * pow(smoothstep(0.42, 1.0, p), 3.0) * 0.95;
    } else if (uMode == 5) {
      // 星轨坍缩: a black hole at the launch star — the wallpaper spirals in,
      // lensed and redshifted, with a bright photon ring and a dark horizon.
      float pull = smoothstep(0.0, 0.92, p);
      vec2 d = (uv - uOrigin) * vec2(uRes.x / uRes.y, 1.0);
      float r = max(length(d), 1e-4);
      float ang = atan(d.y, d.x);
      float spin = (3.4 * pull) / (0.14 + r * 2.4);
      float ca2 = cos(spin);
      float sa2 = sin(spin);
      vec2 rot = vec2(ca2 * d.x - sa2 * d.y, sa2 * d.x + ca2 * d.y);
      float shrink = mix(1.0, 0.015, pull * (1.0 - smoothstep(0.02, 0.95, r)));
      vec2 suv = uOrigin + rot / vec2(uRes.x / uRes.y, 1.0) * shrink;
      vec2 dir2 = normalize(d + vec2(1e-5));
      float disp = 0.008 + 0.055 * pull;
      vec3 c;
      c.r = tex(suv + dir2 * disp).r;
      c.g = tex(suv).g;
      c.b = tex(suv - dir2 * disp).b;
      float horizon = 1.0 - smoothstep(0.0, 0.16 + 0.20 * pull, r);
      c *= 1.0 - horizon;
      float ring = exp(-pow((r - (0.05 + 0.20 * pull)) / 0.012, 2.0));
      c += mix(uTheme, vec3(1.0, 0.93, 0.76), 0.6) * ring * (0.5 + 0.9 * pull);
      c += vec3(0.62, 0.90, 1.0) * exp(-pow((r - 0.035 - 0.32 * pull) / 0.02, 2.0)) * 0.25 * pull;
      col = mix(col, c, smoothstep(0.0, 0.10, p));
      col *= 1.0 - 0.72 * smoothstep(0.86, 1.0, p);
    }
    if (uMode != 5) col = mix(col, vec3(1.0), smoothstep(0.84,1.0,p));
    gl_FragColor = vec4(col, 1.0);
  }`

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  return s
}

/**
 * Full-window launch transition. Renders the wallpaper through one of the
 * launch-effect shaders (refraction shockwave / liquid melt / cyber glitch / gravity) for
 * ~1.3s, then fades out. The wallpaper is used as the source so the effect reads
 * as the whole window warping (a live video frame is frozen).
 */
export default function LaunchTransition({ trigger, onDone }: LaunchTransitionProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const glRef = useRef<WebGLRenderingContext | null>(null)
  const uRef = useRef<Record<string, WebGLUniformLocation | null>>({})
  const themeRef = useRef<[number, number, number]>([0.4, 0.36, 0.9])
  // These are ordinary launch effects, independent of the visual theme.
  const atomShatter = trigger?.effect === 'gravity'
  const outwardShatter = trigger?.effect === 'shatter'
  const nova = trigger?.effect === 'nova'
  const active = !!trigger && !atomShatter && !outwardShatter && trigger.effect !== 'none'
  // Latest onDone without re-triggering the effect (an inline callback would
  // otherwise restart the animation on every App render).
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false })
    if (!gl) return
    glRef.current = gl
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS))
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(prog)
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
    for (const n of ['uTex', 'uRes', 'uTime', 'uOrigin', 'uProgress', 'uMode', 'uTheme']) {
      uRef.current[n] = gl.getUniformLocation(prog, n)
    }
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    glRef.current = gl
    return () => {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      glRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!trigger) return
    if (trigger.effect === 'gravity' || trigger.effect === 'shatter') {
      return
    }
    if (trigger.effect === 'none') return
    const gl = glRef.current
    const canvas = canvasRef.current
    if (!gl || !canvas) return

    const theme = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()
    const hex = /^#?([0-9a-f]{6})$/i.exec(theme)
    if (hex) {
      const v = parseInt(hex[1], 16)
      themeRef.current = [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(window.innerWidth * dpr)
    canvas.height = Math.round(window.innerHeight * dpr)
    gl.viewport(0, 0, canvas.width, canvas.height)

    const src = captureWallpaperBackground(dpr)
    gl.activeTexture(gl.TEXTURE0)
    // (re)create texture content
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    if (src) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    const U = uRef.current
    const mode = MODE[trigger.effect]
    const duration = 1450
    const origin: [number, number] = [trigger.originX ?? 0.5, trigger.originY ?? 0.5]
    const start = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      const k = Math.min(1, (now - start) / duration)
      const p = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
      gl.uniform2f(U.uRes!, canvas.width, canvas.height)
      gl.uniform1f(U.uTime!, (now - start) / 1000)
      gl.uniform2f(U.uOrigin!, origin[0], origin[1])
      gl.uniform1f(U.uProgress!, p)
      gl.uniform1i(U.uMode!, mode)
      gl.uniform3f(U.uTheme!, themeRef.current[0], themeRef.current[1], themeRef.current[2])
      gl.uniform1i(U.uTex!, 0)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      if (k < 1) raf = requestAnimationFrame(tick)
      else onDoneRef.current()
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [trigger])

  return (
    <>
      <canvas ref={canvasRef} className={`launch-fx${active ? ' on' : ''}`} />
      {atomShatter && trigger && (
        <WallpaperShatter
          originX={trigger.originX ?? 0.5}
          originY={1 - (trigger.originY ?? 0.4)}
          onDone={onDone}
        />
      )}
      {nova && trigger && (
        <MitiaNova
          originX={trigger.originX ?? 0.5}
          originY={1 - (trigger.originY ?? 0.4)}
        />
      )}
      {outwardShatter && trigger && (
        <WallpaperBurst
          originX={trigger.originX ?? 0.5}
          originY={1 - (trigger.originY ?? 0.4)}
          onDone={onDone}
        />
      )}
    </>
  )
}
