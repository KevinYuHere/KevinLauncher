import { HardLinkService } from '../services/hardLinkService'
import { getSophonBuild } from './sophon'
import { getSophonPlan } from './sophonPlan'
import { getScenario, selectionFiles } from './hoyoFiles'
import { HoYoSteps, type HoYoStep } from './hoyoSchedule'
import { HoYoWorker, type SophonSetup } from './hoyoWorker'
import { audioEnumNames, detectAudioLanguages, downloadMode, GAME_IDS, getGameBranches, getGameConfig,
  getHoYoPackages, requireGameInfo, selectPackageFiles, type HoYoGame } from './hoyoplay'
import { applyPackages, cleanGameTemps, componentSteps, downloadPackages, moveCachedResources, prepareComponents,
  prepareGameDirectory, preparePackageVerification, readIni, verifyUpdatedPackages, writeIni } from './hoyoPackages'
import type { UpdateMode } from '@shared/types'

export async function prepareHoYoJob(game: HoYoGame, dir: string, mode: UpdateMode, paths: {
  worker: string; hpatchz: string; userData: string; launcherVersion: string
}, signal: AbortSignal): Promise<HoYoSteps> {
  const ini = await readIni(dir)
  const local = ini.get('game_version')
  if (!local) throw new Error('无法读取已安装游戏版本')
  await requireGameInfo(game, signal)
  const config = await getGameConfig(game, signal)
  if (!config) throw new Error('未找到该游戏的启动器配置')
  const flow = downloadMode(config)
  const audio = await detectAudioLanguages(game, dir)
  const scenario = await getScenario(dir, config)
  const predownload = mode === 'preDownload'
  const steps: HoYoStep[] = [ctx => prepareGameDirectory(dir, config, audio, scenario, ctx.signal)]
  let worker: HoYoWorker | undefined
  let links: HardLinkService | undefined
  let version: string
  const close = async () => { await worker?.close(); await links?.close() }
  const prepareExtra = () => predownload ? null : prepareComponents(game, dir, ini, signal)
  try {
    if (flow === 'chunk') {
      const branches = await getGameBranches(game, signal)
      const target = predownload ? branches.preDownload : branches.main
      if (!branches.main || !target) throw new Error('未找到对应的游戏分支')
      const warm = await getSophonBuild(branches.main, undefined, signal)
      const { ignoreFields, blacklist } = await selectionFiles(game, dir, config)
      version = target.tag
      const main = branches.main
      const prepareChunks = async () => {
        const plan = await getSophonPlan(main, target, local, signal, audio, ignoreFields, warm, scenario)
        worker = new HoYoWorker(paths.worker)
        const setup: SophonSetup = { dir, gameId: GAME_IDS[game], userData: paths.userData, launcherVersion: paths.launcherVersion,
          plan, version: local, predownload, hpatchz: paths.hpatchz, blacklist }
        await worker.run({ type: 'prepare', setup }, { signal, progress() {}, phase() {} })
      }
      const [chunk, extra] = await Promise.allSettled([prepareChunks(), prepareExtra()])
      if (chunk.status === 'rejected') throw chunk.reason
      if (extra.status === 'rejected') throw extra.reason
      steps.push(async ctx => {
        if (!predownload) await moveCachedResources(dir, config, ctx.signal)
        await worker!.run({ type: 'update' }, ctx)
      })
      if (!predownload) steps.push(async ctx => {
        ctx.phase('正在校验更新文件…')
        await moveCachedResources(dir, config, ctx.signal)
        await worker!.run({ type: 'verify' }, ctx)
      })
      if (extra.value) steps.push(...componentSteps(dir, ini, extra.value))
    } else {
      const packages = await getHoYoPackages(game, local, signal)
      const target = predownload ? packages.preDownload : packages.main
      if (!target) throw new Error('未找到对应的游戏压缩包')
      version = target.version
      const files = selectPackageFiles(target, audio)
      const [verify, extra] = await Promise.allSettled([
        predownload ? [] : preparePackageVerification(dir, target.resListUrl, audio, signal), prepareExtra()
      ])
      if (verify.status === 'rejected') throw verify.reason
      if (extra.status === 'rejected') throw extra.reason
      links = new HardLinkService(paths.userData, GAME_IDS[game])
      steps.push(async ctx => {
        if (!predownload) await moveCachedResources(dir, config, ctx.signal)
        await downloadPackages(dir, files, ctx.signal, ctx.progress)
        if (!predownload) {
          ctx.phase('正在解压并应用游戏更新…', true)
          await applyPackages(dir, files, paths.hpatchz, ctx.signal, links!)
        }
      })
      if (!predownload) steps.push(async ctx => {
        ctx.phase('正在校验更新文件…')
        await moveCachedResources(dir, config, ctx.signal)
        await verifyUpdatedPackages(dir, verify.value, ctx.signal, ctx.progress)
      })
      if (extra.value) steps.push(...componentSteps(dir, ini, extra.value))
    }
    steps.push(async ctx => {
      if (predownload) ini.set('predownload', [local, version, audioEnumNames(audio)].join(','))
      else { ini.set('game_version', version); ini.delete('predownload') }
      await cleanGameTemps(dir, ctx.signal)
      await writeIni(dir, game, ini)
    })
    return new HoYoSteps(steps, close)
  } catch (error) {
    await close()
    throw error
  }
}
