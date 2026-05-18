// Компактный формат чисел: 415575 → '415к', 1500 → '1.5к', 1500000 → '1.5M'.
// <1000 — без суффикса. Утилита не знает про vue-i18n: единицы передаются явно,
// чтобы оставаться чистой и тестируемой. Вызывающий код подставляет t('dash.acct.unitK') и т.д.
export function formatCompact(n, units = {}) {
  const { unitK = 'k', unitM = 'M' } = units
  const num = Number(n) || 0
  if (num < 1000) return String(num)
  if (num < 1_000_000) {
    const k = num / 1000
    const formatted = k >= 100 ? Math.round(k) : (Math.round(k * 10) / 10)
    return `${formatted}${unitK}`
  }
  const m = num / 1_000_000
  return `${Math.round(m * 10) / 10}${unitM}`
}
