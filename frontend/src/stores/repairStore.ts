import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useDecayStore } from '@/stores/decayStore'
import { useHallStore } from '@/stores/hallStore'
import type { Decay } from '@/types/decay'
import type { Element } from '@/types/element'
import type { Hall } from '@/types/hall'
import type { PaintLayer } from '@/types/layer'
import type { RepairGroup, RepairState, RepairStep, RepairStepName } from '@/types/repair'
import type { RepairStage } from '@/types/decay'

/** 工序状态切换结果，供页面提示与回退计数 */
export interface ChangeStepStateResult {
  ok: boolean
  message: string
  /** 本次顺带被退回「未开始」的后续工序数 */
  resetCount: number
  /** 操作后该病害是否已全部完成 */
  allDone: boolean
}

/**
 * 工序 store：维护工序顺序与完成态，并负责把完成结果回写病害。
 */
export const useRepairStore = defineStore('repair', () => {
  const repairTable = useIdbTable<RepairStep>((database) => database.repairSteps)
  const decayStore = useDecayStore()
  const hallStore = useHallStore()

  const sortMode = ref<'manual' | 'severity'>(readUiPrefs().repairSort)
  const activeDecayId = ref<string | null>(null)

  const steps = computed<RepairStep[]>(() => repairTable.rows.value)

  /**
   * 病害修复阶段派生（现场规矩）：
   * - 待安排：该病害还没有任何工序；
   * - 修复中：已挂工序，但还没全部完成；
   * - 已修复：工序全部完成（含最后一道）。
   */
  const stageMap = computed<Map<string, RepairStage>>(() => {
    const grouped = new Map<string, RepairStep[]>()
    steps.value.forEach((step) => {
      const list = grouped.get(step.decayId) ?? []
      list.push(step)
      grouped.set(step.decayId, list)
    })
    const map = new Map<string, RepairStage>()
    grouped.forEach((list, decayId) => {
      const sorted = [...list].sort((a, b) => a.seq - b.seq)
      if (sorted.length > 0 && sorted.every((step) => step.state === '已完成')) {
        map.set(decayId, '已修复')
      } else {
        map.set(decayId, '修复中')
      }
    })
    return map
  })

  /** 某条病害当前的修复阶段；没有工序即「待安排」 */
  function stageOf(decayId: string): RepairStage {
    return stageMap.value.get(decayId) ?? '待安排'
  }

  /** 各阶段病害条数 */
  const stageCounts = computed<{ pending: number; repairing: number; repaired: number }>(() => {
    let repaired = 0
    let repairing = 0
    decayStore.decays.forEach((decay) => {
      const stage = stageMap.value.get(decay.id)
      if (stage === '已修复') repaired += 1
      else if (stage === '修复中') repairing += 1
    })
    return { pending: decayStore.decays.length - repaired - repairing, repairing, repaired }
  })

  /** 按病害归组的工序时间线 */
  const groups = computed<RepairGroup[]>(() => {
    const layerMap = new Map<string, PaintLayer>()
    decayStore.layers.forEach((layer) => layerMap.set(layer.id, layer))
    const elementMap = new Map<string, Element>()
    decayStore.elements.forEach((element) => elementMap.set(element.id, element))
    const decayMap = new Map<string, Decay>()
    decayStore.decays.forEach((decay) => decayMap.set(decay.id, decay))

    const grouped = new Map<string, RepairStep[]>()
    steps.value.forEach((step) => {
      const list = grouped.get(step.decayId) ?? []
      list.push(step)
      grouped.set(step.decayId, list)
    })

    const result: RepairGroup[] = []
    grouped.forEach((list, decayId) => {
      const sorted = [...list].sort((a, b) => a.seq - b.seq)
      const decay = decayMap.get(decayId) ?? null
      const layer = decay ? layerMap.get(decay.layerId) ?? null : null
      const element = layer ? elementMap.get(layer.elementId) ?? null : null
      const doneCount = sorted.filter((step) => step.state === '已完成').length
      const stage: RepairStage =
        sorted.length > 0 && sorted.every((step) => step.state === '已完成') ? '已修复' : '修复中'
      result.push({
        decayId,
        decay,
        layer,
        element,
        hall: null,
        steps: sorted,
        doneCount,
        totalCount: sorted.length,
        percent: sorted.length === 0 ? 0 : Math.round((doneCount / sorted.length) * 100),
        stage
      })
    })
    return result.sort((a, b) => {
      if (sortMode.value === 'severity') {
        const weight = (group: RepairGroup): number => {
          const severity = group.decay?.severity
          if (severity === '重度') return 3
          if (severity === '中度') return 2
          return 1
        }
        const diff = weight(b) - weight(a)
        if (diff !== 0) return diff
      }
      return a.decayId.localeCompare(b.decayId)
    })
  })

  const totalSteps = computed(() => steps.value.length)
  const doneSteps = computed(() => steps.value.filter((step) => step.state === '已完成').length)
  const runningSteps = computed(() => steps.value.filter((step) => step.state === '进行中').length)
  const overallPercent = computed(() =>
    totalSteps.value === 0 ? 0 : Math.round((doneSteps.value / totalSteps.value) * 100)
  )

  /** 待安排工序的病害（尚无任何工序） */
  const pendingDecays = computed<Decay[]>(() =>
    decayStore.decays.filter((decay) => !steps.value.some((step) => step.decayId === decay.id))
  )

  function groupOf(decayId: string): RepairGroup | undefined {
    return groups.value.find((group) => group.decayId === decayId)
  }

  function decayById(id: string): Decay | null {
    return decayStore.decays.find((decay) => decay.id === id) ?? null
  }

  function setSortMode(mode: 'manual' | 'severity'): void {
    sortMode.value = mode
    writeUiPrefs({ ...readUiPrefs(), repairSort: mode })
  }

  function setActiveDecay(id: string | null): void {
    activeDecayId.value = id
  }

  function nextSeq(decayId: string): number {
    const list = steps.value.filter((step) => step.decayId === decayId)
    return list.length === 0 ? 1 : Math.max(...list.map((step) => step.seq)) + 1
  }

  async function addStep(payload: {
    decayId: string
    name: RepairStepName
    material: string
    operator: string
  }): Promise<RepairStep> {
    const step = await repairTable.create(
      {
        decayId: payload.decayId,
        seq: nextSeq(payload.decayId),
        name: payload.name,
        material: payload.material,
        operator: payload.operator,
        state: '未开始',
        completedAt: null
      },
      'step'
    )
    await syncDecayState(payload.decayId)
    return step
  }

  async function updateStep(id: string, patch: Partial<RepairStep>): Promise<void> {
    // 工序状态只允许走 changeStepState（按序加锁 + 级联），这里剥离状态相关字段
    const safePatch: Partial<RepairStep> = { ...patch }
    delete safePatch.state
    delete safePatch.completedAt
    await repairTable.update(id, safePatch)
  }

  async function removeStep(id: string): Promise<void> {
    const step = steps.value.find((item) => item.id === id)
    if (!step) return
    const decayId = step.decayId
    await repairTable.remove(id)
    await normalizeSeq(decayId)
    await enforceChain(decayId)
    await syncDecayState(decayId)
  }

  async function removeGroup(decayId: string): Promise<void> {
    const ids = steps.value.filter((step) => step.decayId === decayId).map((step) => step.id)
    await repairTable.bulkRemove(ids)
    // 工序被清空：病害回到「待安排」（未修复）
    await syncDecayState(decayId)
  }

  /** 拖拽后按新顺序批量回写 seq，再校正因换位导致的跳序完成 */
  async function reorder(decayId: string, orderedIds: string[]): Promise<number> {
    const now = Date.now()
    await db.transaction('rw', db.repairSteps, async () => {
      for (let index = 0; index < orderedIds.length; index += 1) {
        await db.repairSteps.update(orderedIds[index], { seq: index + 1, updatedAt: now })
      }
      const rest = steps.value
        .filter((step) => step.decayId === decayId && !orderedIds.includes(step.id))
        .sort((a, b) => a.seq - b.seq)
      for (let index = 0; index < rest.length; index += 1) {
        await db.repairSteps.update(rest[index].id, {
          seq: orderedIds.length + index + 1,
          updatedAt: now
        })
      }
    })
    const resetCount = await enforceChain(decayId)
    await syncDecayState(decayId)
    return resetCount
  }

  /**
   * 现场规矩的工序状态机：
   * 1. 前一道没做完，后面的工序点不动（进行中 / 已完成都禁止）；
   * 2. 已完成的工序可退回「进行中」或「未开始」，其后的已完成工序一并退回「未开始」；
   * 3. 已完成记下完成时间，退回时清掉；
   * 4. 全部完成（最后一道已完成）后病害才算「已修复」。
   */
  async function changeStepState(id: string, state: RepairState): Promise<ChangeStepStateResult> {
    const step = steps.value.find((item) => item.id === id)
    if (!step) return { ok: false, message: '工序不存在', resetCount: 0, allDone: false }

    const list = steps.value
      .filter((item) => item.decayId === step.decayId)
      .sort((a, b) => a.seq - b.seq)
    const index = list.findIndex((item) => item.id === id)
    const prevDone = index <= 0 || list[index - 1].state === '已完成'

    // 向前推进（进行中 / 已完成）要求前一道已完成，且不能是无意义的同态切换
    if (state !== step.state && state !== '未开始' && !prevDone) {
      return { ok: false, message: '前一道工序还没做完，后面的工序点不动', resetCount: 0, allDone: false }
    }

    const now = Date.now()
    let resetCount = 0
    await db.transaction('rw', db.repairSteps, async () => {
      const patch: Partial<RepairStep> = {
        state,
        completedAt: state === '已完成' ? step.completedAt ?? now : null,
        updatedAt: now
      }
      await db.repairSteps.update(id, patch)
      // 退回当前工序后，其后的「已完成」工序一并退回「未开始」
      if (state !== '已完成') {
        for (let i = index + 1; i < list.length; i += 1) {
          if (list[i].state === '已完成') {
            await db.repairSteps.update(list[i].id, {
              state: '未开始',
              completedAt: null,
              updatedAt: now
            })
            resetCount += 1
          }
        }
      }
    })

    await syncDecayState(step.decayId)
    const group = groupOf(step.decayId)
    const allDone = !!group && group.doneCount === group.totalCount
    const message = allDone
      ? '最后一道工序已完成，该病害记为已修复'
      : `工序已改为「${state}」`
    return { ok: true, message, resetCount, allDone }
  }

  /**
   * 链条校正：保证「已完成」是从第一道起的连续前缀。
   * 删除工序、拖拽换位后调用；返回被退回「未开始」的工序数。
   */
  async function enforceChain(decayId: string): Promise<number> {
    const list = await db.repairSteps.where('decayId').equals(decayId).toArray()
    const sorted = [...list].sort((a, b) => a.seq - b.seq)
    let firstOpen = -1
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i].state !== '已完成') {
        firstOpen = i
        break
      }
    }
    const now = Date.now()
    let resetCount = 0
    await db.transaction('rw', db.repairSteps, async () => {
      for (let index = 0; index < sorted.length; index += 1) {
        const step = sorted[index]
        const shouldReset = firstOpen >= 0 && index > firstOpen && step.state === '已完成'
        if (shouldReset) {
          await db.repairSteps.update(step.id, { state: '未开始', completedAt: null, updatedAt: now })
          resetCount += 1
        }
      }
    })
    return resetCount
  }

  /** 回写病害修复态：没有工序 → 未修复（待安排）；全部完成 → 已修复；其余 → 未修复（修复中） */
  async function syncDecayState(decayId: string): Promise<void> {
    const list = await db.repairSteps.where('decayId').equals(decayId).toArray()
    const allDone = list.length > 0 && list.every((step) => step.state === '已完成')
    await decayStore.setRepaired(decayId, allDone)
  }

  async function normalizeSeq(decayId: string): Promise<void> {
    const list = await db.repairSteps.where('decayId').equals(decayId).toArray()
    const sorted = list.sort((a, b) => a.seq - b.seq)
    const now = Date.now()
    await db.transaction('rw', db.repairSteps, async () => {
      for (let index = 0; index < sorted.length; index += 1) {
        if (sorted[index].seq !== index + 1) {
          await db.repairSteps.update(sorted[index].id, { seq: index + 1, updatedAt: now })
        }
      }
    })
  }

  /** 一键为某殿宇下所有未修复病害补齐标准工序链 */
  async function scaffoldForHall(hallId: string, template: RepairStepName[]): Promise<number> {
    const targets = decayStore.rows.filter(
      (row) => row.hallId === hallId && !steps.value.some((step) => step.decayId === row.decay.id)
    )
    const now = Date.now()
    const records: RepairStep[] = []
    targets.forEach((row) => {
      template.forEach((name, index) => {
        records.push({
          id: `${row.decay.id}_${index}_${Math.random().toString(36).slice(2, 7)}`,
          decayId: row.decay.id,
          seq: index + 1,
          name,
          material: '',
          operator: '',
          state: '未开始',
          completedAt: null,
          createdAt: now,
          updatedAt: now
        })
      })
    })
    if (records.length > 0) await db.repairSteps.bulkPut(records)
    return records.length
  }

  /** 工序分组所属殿宇，用于时间线标题回显 */
  function hallOfGroup(group: RepairGroup): Hall | null {
    const hallId = group.element?.hallId
    if (!hallId) return null
    return hallStore.hallById(hallId) ?? null
  }

  return {
    steps,
    groups,
    stageMap,
    stageOf,
    stageCounts,
    sortMode,
    activeDecayId,
    totalSteps,
    doneSteps,
    runningSteps,
    overallPercent,
    pendingDecays,
    groupOf,
    decayById,
    hallOfGroup,
    setSortMode,
    setActiveDecay,
    nextSeq,
    addStep,
    updateStep,
    removeStep,
    removeGroup,
    reorder,
    changeStepState,
    syncDecayState,
    normalizeSeq,
    scaffoldForHall
  }
})
