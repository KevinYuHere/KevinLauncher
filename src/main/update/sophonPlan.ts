import type { BranchPackage } from './hoyoplay'
import { BuildNotFound, getSophonBuild, type SophonBuild } from './sophon'
import { getPatchBuild, PatchBuildNotFound } from './sophonPatch'

export function selectCategories<T extends { categories: { categoryId: string }[] }>(
  build: T, branch: BranchPackage, audio: string[], ignored: string[], scenario = 'CATEGORY_SCENARIO_FULL'
): T {
  const ids = new Set(branch.categories.filter(category =>
    category.scenarios?.includes(scenario) && !ignored.includes(category.matching_field) &&
    (category.type === 'CATEGORY_TYPE_RESOURCE' ||
      (category.type === 'CATEGORY_TYPE_AUDIO' && audio.some(lang => category.matching_field?.includes(lang))))
  ).map(category => category.category_id))
  return { ...build, categories: build.categories.filter(category => ids.has(category.categoryId)) }
}

/** Behavior reference: Starward 747ed10 branch selection during update and predownload. */
export async function getSophonPlan(
  main: BranchPackage, target: BranchPackage, localVersion: string, signal: AbortSignal,
  audio: string[] = [], ignored: string[] = [], warmedMain?: SophonBuild, scenario = 'CATEGORY_SCENARIO_FULL'
) {
  const mainBuild = selectCategories(warmedMain ?? await getSophonBuild(main, undefined, signal), main, audio, ignored, scenario)
  if (target.diffTags.includes(localVersion)) {
    try {
      const patch = selectCategories(await getPatchBuild(target, signal), target, audio, ignored, scenario)
      return { kind: 'patch' as const, patch, mainBuild }
    } catch (error) {
      if (error instanceof PatchBuildNotFound) throw new Error('官方补丁暂不可用，请稍后重试')
      throw error
    }
  }
  const localBuild = await getSophonBuild(main, localVersion, signal)
    .then(build => selectCategories(build, main, audio, ignored, scenario))
    .catch(error => {
      if (error instanceof BuildNotFound) return undefined
      throw error
    })
  const build = target.packageId === main.packageId && target.branch === main.branch
    ? mainBuild : selectCategories(await getSophonBuild(target, undefined, signal), target, audio, ignored, scenario)
  return { kind: 'chunk' as const, build, localBuild }
}
