/** 病害记录：某彩画层位上的一处病害现状 */
export type DecayType = '起甲' | '剥落' | '空鼓' | '粉化' | '龟裂'
export type Severity = '轻度' | '中度' | '重度'

export interface Decay {
  id: string
  layerId: string
  type: DecayType
  severity: Severity
  /** 病害面积（平方厘米） */
  areaCm2: number
  /** 病害成因初判 */
  causeGuess: string
  /** 由修复工序完成后回写 */
  repaired: boolean
  repairedAt: number | null
  createdAt: number
  updatedAt: number
}

export const DECAY_TYPES: DecayType[] = ['起甲', '剥落', '空鼓', '粉化', '龟裂']
export const SEVERITIES: Severity[] = ['轻度', '中度', '重度']

/**
 * 病害修复阶段（由工序情况现场派生，不单独入库）：
 * - 待安排：该病害还没有挂任何修复工序；
 * - 修复中：已挂工序，且工序尚未全部完成；
 * - 已修复：最后一道工序已完成（此时病害 repaired 才会回写为 true）。
 */
export type RepairStage = '待安排' | '修复中' | '已修复'

export const REPAIR_STAGES: RepairStage[] = ['待安排', '修复中', '已修复']

/** 病害档案台的组合筛选条件 */
export interface DecayFilterState {
  keyword: string
  halls: string[]
  elementPositions: string[]
  types: DecayType[]
  severities: Severity[]
  pigments: string[]
  /** 修复阶段筛选，'' 表示不筛选 */
  stage: RepairStage | ''
}

export function createEmptyDecayFilter(): DecayFilterState {
  return {
    keyword: '',
    halls: [],
    elementPositions: [],
    types: [],
    severities: [],
    pigments: [],
    stage: ''
  }
}
