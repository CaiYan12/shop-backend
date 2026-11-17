import { sql } from 'drizzle-orm'
import {
  check,
  decimal,
  index,
  int,
  json,
  mysqlTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

/**
 * 商品类型：单层分类（D45），slug 唯一且创建后保持稳定（D39）。
 */
export const categories = mysqlTable('categories', {
  id: int('id').autoincrement().primaryKey(),
  slug: varchar('slug', { length: 64 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(),
}, (table) => [
  uniqueIndex('categories_slug_unique').on(table.slug),
])

/** 详情块：文本与图片两型（D47）。 */
export type DetailBlock =
  | { type: 'text', text: string }
  | { type: 'image', path: string, alt: string }

/** 商品级规格维度元数据（D40）；组合级选项值由规格组合表承载（T3）。 */
export interface DimensionMetadata {
  name: string
  options: string[]
}

/**
 * 商品：slug 唯一且创建后保持稳定（D39）；评分 decimal(2,1) 范围 0–5、
 * 销量非负由 CHECK 兜底（D44、D54）；时间字段统一 UTC（D50）。
 */
export const products = mysqlTable('products', {
  id: int('id').autoincrement().primaryKey(),
  slug: varchar('slug', { length: 64 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  categoryId: int('category_id').notNull().references(() => categories.id),
  brand: varchar('brand', { length: 64 }).notNull(),
  model: varchar('model', { length: 64 }).notNull(),
  rating: decimal('rating', { precision: 2, scale: 1, mode: 'number' }).notNull(),
  sales: int('sales').notNull(),
  detail: json('detail').$type<DetailBlock[]>().notNull(),
  dimensions: json('dimensions').$type<DimensionMetadata[]>().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex('products_slug_unique').on(table.slug),
  index('products_category_id_index').on(table.categoryId),
  check('products_rating_check', sql`${table.rating} >= 0 AND ${table.rating} <= 5`),
  check('products_sales_check', sql`${table.sales} >= 0`),
])

/**
 * 规格组合：商品下的一个可售单元，持有独立价格、原价与库存（D40、D43、D44）。
 * 组合级只用两个选项值列，按商品声明的维度顺序解释；不另存组合的 specs JSON（ADR 0001）。
 */
export const productVariants = mysqlTable('product_variants', {
  id: int('id').autoincrement().primaryKey(),
  productId: int('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  sku: varchar('sku', { length: 64 }).notNull(),
  option1Value: varchar('option1_value', { length: 64 }).notNull(),
  option2Value: varchar('option2_value', { length: 64 }).notNull(),
  price: decimal('price', { precision: 10, scale: 2, mode: 'number' }).notNull(),
  originalPrice: decimal('original_price', { precision: 10, scale: 2, mode: 'number' }).notNull(),
  stock: int('stock').notNull(),
}, (table) => [
  uniqueIndex('product_variants_sku_unique').on(table.sku),
  uniqueIndex('product_variants_product_id_options_unique').on(
    table.productId,
    table.option1Value,
    table.option2Value,
  ),
  check('product_variants_stock_check', sql`${table.stock} >= 0`),
])

/**
 * 商品图片：路径为 /images/products/{slug}/n.webp 形式的相对路径（D48），
 * 归属由应用层按规范化路径校验；图片按商品整体替换（D52）。
 */
export const productImages = mysqlTable('product_images', {
  id: int('id').autoincrement().primaryKey(),
  productId: int('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  path: varchar('path', { length: 255 }).notNull(),
  sortOrder: int('sort_order').notNull(),
  alt: varchar('alt', { length: 255 }).notNull(),
}, (table) => [
  index('product_images_product_id_index').on(table.productId),
  uniqueIndex('product_images_product_id_path_unique').on(table.productId, table.path),
  check('product_images_sort_order_check', sql`${table.sortOrder} >= 0`),
])
