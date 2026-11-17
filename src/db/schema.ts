import { int, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'

/**
 * 商品类型：单层分类（D45），slug 唯一且创建后保持稳定（D39）。
 * 商品、商品图片与规格组合表在 T2 / T3 加入本文件。
 */
export const categories = mysqlTable('categories', {
  id: int('id').autoincrement().primaryKey(),
  slug: varchar('slug', { length: 64 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(),
}, (table) => [
  uniqueIndex('categories_slug_unique').on(table.slug),
])
