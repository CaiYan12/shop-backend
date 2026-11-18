import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm'
import { priceCentsSql } from '../money.ts'
import type { Database } from './client.ts'
import { productSummaryQuery } from './product-summary.ts'
import { categories, productImages, products } from './schema.ts'

/**
 * 列表排序（D61）：价格升序、价格降序、销量降序；同值一律按商品 id 升序。
 * 路由 schema 由这份常量生成，避免枚举值在两处各写一遍。
 */
export const PRODUCT_LIST_SORTS = ['price_asc', 'price_desc', 'sales_desc'] as const

export type ProductListSort = (typeof PRODUCT_LIST_SORTS)[number]

/** 列表查询条件；未提供的筛选条件表示不限。 */
export interface ProductListQuery {
  category?: string
  priceMinCents?: number
  priceMaxCents?: number
  minSales?: number
  sort: ProductListSort
  page: number
  pageSize: number
}

export interface ProductListRow {
  productId: number
  slug: string
  name: string
  brand: string
  model: string
  categorySlug: string
  categoryName: string
  displayPrice: number
  displayOriginalPrice: number
  soldOut: boolean
  rating: number
  sales: number
  coverImage: { path: string, alt: string } | null
}

export interface ProductListPage {
  rows: ProductListRow[]
  total: number
}

/**
 * 列表行的字段投影（D67）：MySQL 直查与关键词命中补齐共用一份，
 * 避免同一组展示字段在两处各写一遍、日后改一处漏一处。
 */
function listRowProjection (db: Database) {
  const summary = productSummaryQuery(db).as('product_summary')
  return {
    summary,
    selection: {
      productId: products.id,
      slug: products.slug,
      name: products.name,
      brand: products.brand,
      model: products.model,
      categorySlug: categories.slug,
      categoryName: categories.name,
      displayPrice: summary.displayPrice,
      displayOriginalPrice: summary.displayOriginalPrice,
      soldOut: summary.soldOut,
      rating: products.rating,
      sales: products.sales,
    },
  }
}

/**
 * 在派生查询外层组合筛选与排序（D61）：
 * 展示价以元存储，经 `priceCentsSql` 换算成整数分后再比较，DECIMAL 运算不引入浮点误差；
 * 排序在展示价或销量之后统一追加商品 id 升序，保证翻页稳定。
 */
function buildListQuery (db: Database, query: ProductListQuery) {
  const { summary, selection } = listRowProjection(db)

  const conditions: SQL[] = []
  if (query.category !== undefined) {
    conditions.push(eq(categories.slug, query.category))
  }
  if (query.priceMinCents !== undefined) {
    conditions.push(gte(priceCentsSql(summary.displayPrice), query.priceMinCents))
  }
  if (query.priceMaxCents !== undefined) {
    conditions.push(lte(priceCentsSql(summary.displayPrice), query.priceMaxCents))
  }
  if (query.minSales !== undefined) {
    conditions.push(gte(products.sales, query.minSales))
  }

  const filtered = db
    .select(selection)
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .innerJoin(summary, eq(summary.productId, products.id))
    .where(conditions.length === 0 ? undefined : and(...conditions))

  const ordered = query.sort === 'price_asc'
    ? filtered.orderBy(asc(summary.displayPrice), asc(products.id))
    : query.sort === 'price_desc'
      ? filtered.orderBy(desc(summary.displayPrice), asc(products.id))
      : filtered.orderBy(desc(products.sales), asc(products.id))

  // 计数用只含商品 id 的派生表：外层 select 的 slug / name 会与商品类型同名列重名，
  // 直接整体包成派生表会被 MySQL 拒绝（ER_DUP_FIELDNAME）。
  const countSource = db
    .select({ productId: products.id })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .innerJoin(summary, eq(summary.productId, products.id))
    .where(conditions.length === 0 ? undefined : and(...conditions))

  return { ordered, countSource }
}

/** 封面图：按 sort_order 升序、同序按 id 升序取第一张（D67）；列表与相关推荐共用。 */
export async function selectCoverImages (
  db: Database,
  productIds: number[],
): Promise<Map<number, { path: string, alt: string }>> {
  const covers = new Map<number, { path: string, alt: string }>()
  if (productIds.length === 0) return covers

  const rows = await db
    .select({
      productId: productImages.productId,
      path: productImages.path,
      alt: productImages.alt,
    })
    .from(productImages)
    .where(inArray(productImages.productId, productIds))
    .orderBy(asc(productImages.productId), asc(productImages.sortOrder), asc(productImages.id))

  for (const row of rows) {
    if (!covers.has(row.productId)) {
      covers.set(row.productId, { path: row.path, alt: row.alt })
    }
  }
  return covers
}

/** 执行列表查询：总数与当前页一次取回；无结果时 total 为 0。 */
export async function selectProductListPage (
  db: Database,
  query: ProductListQuery,
): Promise<ProductListPage> {
  const { ordered, countSource } = buildListQuery(db, query)

  const [countRow] = await db
    .select({ total: sql<number>`COUNT(*)`.mapWith(Number) })
    .from(countSource.as('filtered_products'))

  const rows = await ordered
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)

  const covers = await selectCoverImages(db, rows.map((row) => row.productId))

  return {
    total: countRow?.total ?? 0,
    rows: rows.map((row) => ({
      ...row,
      coverImage: covers.get(row.productId) ?? null,
    })),
  }
}

/**
 * 按商品 id 批量取列表行（#21、ADR 0002）：关键词命中与顺序由 Elasticsearch 给出，
 * 展示字段仍以 MySQL 为权威，用与列表同一条派生查询补齐。
 *
 * - 返回 Map 而不是数组：顺序由调用方按命中顺序决定，不受 IN 查询返回顺序影响；
 * - 封面图一律为 null，由调用方用 `selectCoverImages` 补齐（与相关推荐同一条路径）；
 * - 命中在 MySQL 缺失时不会凭空补出条目，由调用方按数据完整性异常处理。
 */
export async function selectProductListRowsByIds (
  db: Database,
  productIds: number[],
): Promise<Map<number, ProductListRow>> {
  const rows = new Map<number, ProductListRow>()
  if (productIds.length === 0) return rows

  const { summary, selection } = listRowProjection(db)
  const found = await db
    .select(selection)
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .innerJoin(summary, eq(summary.productId, products.id))
    .where(inArray(products.id, productIds))

  for (const row of found) {
    rows.set(row.productId, { ...row, coverImage: null })
  }
  return rows
}
