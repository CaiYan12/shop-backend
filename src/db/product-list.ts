import { and, asc, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm'
import type { Database } from './client.ts'
import { productSummaryQuery } from './product-summary.ts'
import { categories, productImages, products } from './schema.ts'

/** 列表排序（D61）：价格升序、价格降序、销量降序；同值一律按商品 id 升序。 */
export type ProductListSort = 'price_asc' | 'price_desc' | 'sales_desc'

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
 * 在派生查询外层组合筛选与排序（D61）：
 * 展示价以元存储，乘 100 后与整数分比较，DECIMAL 运算不引入浮点误差；
 * 排序在展示价或销量之后统一追加商品 id 升序，保证翻页稳定。
 */
function buildListQuery (db: Database, query: ProductListQuery) {
  const summary = productSummaryQuery(db).as('product_summary')

  const conditions: SQL[] = []
  if (query.category !== undefined) {
    conditions.push(eq(categories.slug, query.category))
  }
  if (query.priceMinCents !== undefined) {
    conditions.push(sql`${summary.displayPrice} * 100 >= ${query.priceMinCents}`)
  }
  if (query.priceMaxCents !== undefined) {
    conditions.push(sql`${summary.displayPrice} * 100 <= ${query.priceMaxCents}`)
  }
  if (query.minSales !== undefined) {
    conditions.push(gte(products.sales, query.minSales))
  }

  const filtered = db
    .select({
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
    })
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
  const idQuery = db
    .select({ productId: products.id })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .innerJoin(summary, eq(summary.productId, products.id))
    .where(conditions.length === 0 ? undefined : and(...conditions))

  return { ordered, idQuery }
}

/** 封面图：按 sort_order 升序、同序按 id 升序取第一张（D67）。 */
async function selectCoverImages (
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
  const { ordered, idQuery } = buildListQuery(db, query)

  const [countRow] = await db
    .select({ total: sql<number>`COUNT(*)`.mapWith(Number) })
    .from(idQuery.as('filtered_products'))

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
