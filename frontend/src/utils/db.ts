import Dexie, { type Table } from 'dexie'
import type { Hall } from '@/types/hall'
import type { Element } from '@/types/element'
import type { PaintLayer } from '@/types/layer'
import type { Decay } from '@/types/decay'
import type { RepairStep } from '@/types/repair'

/**
 * 统一校正工序链与病害修复态（v3 升级、备份导入后均调用）。
 *
 * 现场规矩：工序必须按序推进，「已完成」只能是从第一道起的连续前缀；
 * 凡是前序未完成而自己已完成的跳序数据，一律退回「未开始」并清掉完成时间。
 * 病害修复态完全由工序回算：没有工序或工序未全部完成 → 未修复；
 * 全部完成 → 已修复（补上完成时间）。
 */
export async function reconcileRepairChains(tables: {
  repairSteps: Pick<Table<RepairStep, string>, 'toArray' | 'bulkPut'>
  decays: Pick<Table<Decay, string>, 'toArray' | 'bulkPut'>
}): Promise<void> {
  const now = Date.now()
  const [allSteps, allDecays] = await Promise.all([tables.repairSteps.toArray(), tables.decays.toArray()])

  const grouped = new Map<string, RepairStep[]>()
  allSteps.forEach((step) => {
    const list = grouped.get(step.decayId) ?? []
    list.push(step)
    grouped.set(step.decayId, list)
  })

  const changedSteps: RepairStep[] = []
  const repairedDecayIds = new Set<string>()
  grouped.forEach((list, decayId) => {
    const sorted = [...list].sort((a, b) => a.seq - b.seq)
    // 第一道非「已完成」工序的位置；它之后不允许再出现「已完成」
    let firstOpen = -1
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i].state !== '已完成') {
        firstOpen = i
        break
      }
    }
    sorted.forEach((step, index) => {
      const outOfOrder = firstOpen >= 0 && index > firstOpen && step.state === '已完成'
      let state = step.state
      if (outOfOrder || (step.state !== '未开始' && step.state !== '进行中' && step.state !== '已完成')) {
        state = '未开始'
      }
      let completedAt: number | null = step.completedAt ?? null
      if (state === '已完成') {
        if (!completedAt) completedAt = step.updatedAt ?? now
      } else if (completedAt !== null) {
        completedAt = null
      }
      if (state !== step.state || completedAt !== (step.completedAt ?? null)) {
        changedSteps.push({ ...step, state, completedAt })
      }
    })
    if (firstOpen === -1 && sorted.length > 0) repairedDecayIds.add(decayId)
  })

  const changedDecays: Decay[] = allDecays
    .filter((decay) => {
      const repaired = repairedDecayIds.has(decay.id)
      return repaired !== decay.repaired || (repaired && !decay.repairedAt)
    })
    .map((decay) =>
      repairedDecayIds.has(decay.id)
        ? { ...decay, repaired: true, repairedAt: decay.repairedAt ?? now, updatedAt: now }
        : { ...decay, repaired: false, repairedAt: null, updatedAt: now }
    )

  if (changedSteps.length > 0) await tables.repairSteps.bulkPut(changedSteps)
  if (changedDecays.length > 0) await tables.decays.bulkPut(changedDecays)
}

/** 本地结构版本号：新增/修改表结构时必须递增，并补充 upgrade 迁移 */
export const DB_VERSION = 3

/** 本地存储键名（localStorage 侧的少量元数据） */
export const LS_KEYS = {
  dbVersion: 'gbmuralarch:db-version',
  lastBackupAt: 'gbmuralarch:last-backup-at',
  uiPrefs: 'gbmuralarch:ui-prefs'
} as const

export interface UiPrefs {
  lastHallId: string | null
  repairSort: 'manual' | 'severity'
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  lastHallId: null,
  repairSort: 'manual'
}

/** 备份文件结构，供 export.ts / BackupView 使用 */
export interface BackupPayload {
  app: 'gbmuralarch'
  dbVersion: number
  exportedAt: string
  halls: Hall[]
  elements: Element[]
  layers: PaintLayer[]
  decays: Decay[]
  repairSteps: RepairStep[]
}

export class MuralArchDatabase extends Dexie {
  halls!: Table<Hall, string>
  elements!: Table<Element, string>
  layers!: Table<PaintLayer, string>
  decays!: Table<Decay, string>
  repairSteps!: Table<RepairStep, string>

  constructor() {
    super('gbmuralarch')
    this.version(1).stores({
      halls: 'id, name, era, structureType, roofType, updatedAt',
      elements: 'id, hallId, position, status, updatedAt',
      layers: 'id, elementId, level, patternName, pigment',
      decays: 'id, layerId, type, severity, repaired, updatedAt',
      repairSteps: 'id, decayId, seq, state, updatedAt'
    })
    // v2：病害表补充 repairedAt 索引，工序表补充 name 索引
    this.version(2)
      .stores({
        halls: 'id, name, era, structureType, roofType, updatedAt',
        elements: 'id, hallId, position, status, updatedAt',
        layers: 'id, elementId, level, patternName, pigment',
        decays: 'id, layerId, type, severity, repaired, repairedAt, updatedAt',
        repairSteps: 'id, decayId, seq, name, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据 repaired 为 true 但缺少 repairedAt，用 updatedAt 回填
        await tx
          .table<Decay>('decays')
          .toCollection()
          .modify((decay) => {
            if (decay.repaired && !decay.repairedAt) {
              decay.repairedAt = decay.updatedAt ?? Date.now()
            }
            if (typeof decay.repaired !== 'boolean') {
              decay.repaired = false
            }
          })
      })
    // v3：工序表补充 completedAt 索引；工序改为严格按序推进，
    // 升级时统一校正历史「跳序完成 / 手工标记」造成的不合规数据。
    this.version(DB_VERSION)
      .stores({
        halls: 'id, name, era, structureType, roofType, updatedAt',
        elements: 'id, hallId, position, status, updatedAt',
        layers: 'id, elementId, level, patternName, pigment',
        decays: 'id, layerId, type, severity, repaired, repairedAt, updatedAt',
        repairSteps: 'id, decayId, seq, name, state, completedAt, updatedAt'
      })
      .upgrade(async (tx) => {
        await reconcileRepairChains({
          repairSteps: tx.table<RepairStep>('repairSteps'),
          decays: tx.table<Decay>('decays')
        })
      })
  }
}

export const db = new MuralArchDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 清空全部业务表，供「清空本地数据」与导入前的覆盖使用 */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.halls, db.elements, db.layers, db.decays, db.repairSteps],
    async () => {
      await Promise.all([
        db.halls.clear(),
        db.elements.clear(),
        db.layers.clear(),
        db.decays.clear(),
        db.repairSteps.clear()
      ])
    }
  )
}

/** 读取 localStorage 中的 UI 偏好 */
export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastHallId: typeof parsed.lastHallId === 'string' ? parsed.lastHallId : null,
      repairSort: parsed.repairSort === 'severity' ? 'severity' : 'manual'
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

/** 写入 localStorage 中的 UI 偏好 */
export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

/** 记录数据库结构版本到 localStorage，便于备份页比对 */
export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const raw = localStorage.getItem(LS_KEYS.dbVersion)
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
