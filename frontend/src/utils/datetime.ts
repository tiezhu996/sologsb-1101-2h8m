/**
 * 把毫秒时间戳格式化为「YYYY-MM-DD HH:mm」，供工序完成时间等回显。
 * 入参为 null/undefined 时返回空串。
 */
export function formatDateTime(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return ''
  const date = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}
