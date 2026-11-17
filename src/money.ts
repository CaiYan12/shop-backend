import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'

/**
 * 元与分的转换集中在此（D59）：数据库以 DECIMAL(10,2) 存元，
 * 对外一律用整数分；转换结果必须是安全整数，否则视为数据异常。
 */
export function yuanToCents (yuan: number): number {
  const cents = Math.round(yuan * 100)
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`金额 ${yuan} 无法安全转换为整数分`)
  }
  return cents
}

/**
 * 元→分的 SQL 表达式（D59）：筛选、排序按整数分比较时复用同一换算系数，
 * 避免在查询里另写 `* 100` 造成两套换算规则。
 */
export function priceCentsSql (column: SQLWrapper): SQL {
  return sql`${column} * 100`
}
