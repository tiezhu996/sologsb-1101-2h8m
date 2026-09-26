import { computed, watch, type ComputedRef, type Ref } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useDecayStore, type DecayRow } from '@/stores/decayStore'
import { useHallStore } from '@/stores/hallStore'
import { useRepairStore } from '@/stores/repairStore'
import {
  createEmptyDecayFilter,
  DECAY_TYPES,
  REPAIR_STAGES,
  SEVERITIES,
  type DecayFilterState,
  type DecayType,
  type RepairStage,
  type Severity
} from '@/types/decay'
import { ELEMENT_POSITIONS } from '@/types/element'
import { PIGMENTS } from '@/types/layer'
import { compareSeverity } from '@/utils/severity'

export interface UseDecayFilterOptions {
  /** 是否把筛选条件同步到 URL query，默认 true */
  syncUrl?: boolean
  /** 初始筛选条件（仅在首次挂载时合并） */
  initial?: Partial<DecayFilterState>
}

export interface UseDecayFilterResult {
  filter: Ref<DecayFilterState>
  keyword: ComputedRef<string>
  hallOptions: ComputedRef<Array<{ label: string; value: string }>>
  positionOptions: string[]
  typeOptions: DecayType[]
  severityOptions: Severity[]
  pigmentOptions: string[]
  rows: ComputedRef<DecayRow[]>
  filteredRows: ComputedRef<DecayRow[]>
  sortedRows: ComputedRef<DecayRow[]>
  severityCounts: ComputedRef<Record<Severity, number>>
  typeCounts: ComputedRef<Record<string, number>>
  pigmentCounts: ComputedRef<Record<string, number>>
  total: ComputedRef<number>
  filteredCount: ComputedRef<number>
  filteredArea: ComputedRef<number>
  hasFilter: ComputedRef<boolean>
  patch: (patch: Partial<DecayFilterState>) => void
  reset: () => void
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string' && value.length > 0) return value.split(',')
  return []
}

/**
 * 病害筛选状态与派生结果：条件存于 decayStore，必要时与 URL query 双向同步。
 */
export function useDecayFilter(options: UseDecayFilterOptions = {}): UseDecayFilterResult {
  const { syncUrl = true, initial } = options
  const decayStore = useDecayStore()
  const hallStore = useHallStore()
  const repairStore = useRepairStore()
  const route = useRoute()
  const router = useRouter()

  const { filter } = storeToRefs(decayStore)
  const { halls } = storeToRefs(hallStore)

  function toStage(value: unknown): RepairStage | '' {
    if (typeof value === 'string' && (REPAIR_STAGES as string[]).includes(value)) {
      return value as RepairStage
    }
    return ''
  }

  const patch = (next: Partial<DecayFilterState>): void => {
    decayStore.patchFilter(next)
    if (syncUrl) void pushQuery()
  }

  const reset = (): void => {
    decayStore.resetFilter()
    if (syncUrl) void pushQuery()
  }

  const pushQuery = async (): Promise<void> => {
    const query: LocationQueryRaw = {}
    if (filter.value.keyword.trim()) query.kw = filter.value.keyword.trim()
    if (filter.value.halls.length) query.halls = filter.value.halls.join(',')
    if (filter.value.elementPositions.length) query.pos = filter.value.elementPositions.join(',')
    if (filter.value.types.length) query.types = filter.value.types.join(',')
    if (filter.value.severities.length) query.sev = filter.value.severities.join(',')
    if (filter.value.pigments.length) query.pig = filter.value.pigments.join(',')
    if (filter.value.stage) query.stage = filter.value.stage
    await router.replace({ query })
  }

  const readQuery = (): void => {
    if (!syncUrl) return
    const query = route.query
    decayStore.patchFilter({
      keyword: typeof query.kw === 'string' ? query.kw : '',
      halls: toArray(query.halls),
      elementPositions: toArray(query.pos),
      types: toArray(query.types).filter((item): item is DecayType =>
        (DECAY_TYPES as string[]).includes(item)
      ),
      severities: toArray(query.sev).filter((item): item is Severity =>
        (SEVERITIES as string[]).includes(item)
      ),
      pigments: toArray(query.pig),
      stage: toStage(query.stage)
    })
  }

  // 首次挂载：URL 优先，其次使用 initial，最后保持 store 现值
  const queryFilled = syncUrl && Object.keys(route.query).length > 0
  if (queryFilled) {
    readQuery()
  } else if (initial) {
    decayStore.patchFilter({ ...createEmptyDecayFilter(), ...initial })
  }

  if (syncUrl) {
    watch(
      () => route.query,
      (query) => {
        if (Object.keys(query).length === 0 && decayStore.hasFilter) {
          decayStore.resetFilter()
          return
        }
        readQuery()
      }
    )
  }

  const keyword = computed(() => filter.value.keyword)
  const hallOptions = computed(() =>
    halls.value.map((hall) => ({ label: `${hall.name}（${hall.era}）`, value: hall.id }))
  )

  const rows = computed(() => decayStore.filteredRows)

  /** 在 store 基础筛选之上，再叠加「修复阶段」筛选（阶段由工序派生） */
  const stageRows = computed<DecayRow[]>(() => {
    if (!filter.value.stage) return rows.value
    return rows.value.filter((row) => repairStore.stageOf(row.decay.id) === filter.value.stage)
  })

  const sortedRows = computed(() =>
    [...stageRows.value].sort((a, b) =>
      compareSeverity(a.decay.severity, b.decay.severity, a.decay.areaCm2, b.decay.areaCm2)
    )
  )

  const stageCount = computed(() => stageRows.value.length)
  const stageArea = computed(() => stageRows.value.reduce((sum, row) => sum + row.decay.areaCm2, 0))

  return {
    filter,
    keyword,
    hallOptions,
    positionOptions: ELEMENT_POSITIONS,
    typeOptions: DECAY_TYPES,
    severityOptions: SEVERITIES,
    pigmentOptions: PIGMENTS,
    rows,
    filteredRows: stageRows,
    sortedRows,
    severityCounts: computed(() => decayStore.severityCounts),
    typeCounts: computed(() => decayStore.typeCounts),
    pigmentCounts: computed(() => decayStore.pigmentCounts),
    total: computed(() => decayStore.decays.length),
    filteredCount: stageCount,
    filteredArea: stageArea,
    hasFilter: computed(() => decayStore.hasFilter),
    patch,
    reset
  }
}
