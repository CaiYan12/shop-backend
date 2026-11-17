import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { Database } from './client.ts'
import { products, productVariants } from './schema.ts'

/** 每件商品的派生摘要（D49）：展示价、展示原价与售罄状态在查询时计算，不落列。 */
export interface ProductSummary {
  productId: number
  slug: string
  name: string
  displayPrice: number
  /** 与 displayPrice 取自同一条组合的原价（D43）。 */
  displayOriginalPrice: number
  soldOut: boolean
}

/** 派生查询的过滤条件；空数组表示不匹配任何商品。 */
export interface ProductSummaryFilter {
  productIds?: number[]
  slugs?: string[]
}

/**
 * 组合级派生：每个商品一行，给出展示价、展示原价与售罄状态（D49、D43）。
 *
 * - 被选中的组合：有库存的组合优先，其次价格升序，同价取 id 最小。
 * - 展示价与展示原价都取自这一条组合，因此两者必然同源。
 * - 售罄：有效组合库存之和为 0。
 *
 * 以子查询形式返回，Phase 3 可在商品外层查询中直接按 display_price
 * 过滤与排序（D46），无需再算一遍。
 */
function productVariantSummary (db: Database) {
  const totals = db
    .select({
      productId: productVariants.productId,
      soldOut: sql<boolean>`(SUM(${productVariants.stock}) = 0)`
        .mapWith((value) => Number(value) === 1)
        .as('sold_out'),
    })
    .from(productVariants)
    .groupBy(productVariants.productId)
    .as('product_variant_totals')

  const ranked = db
    .select({
      productId: productVariants.productId,
      price: productVariants.price,
      originalPrice: productVariants.originalPrice,
      pickRank: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${productVariants.productId}
        ORDER BY (${productVariants.stock} > 0) DESC, ${productVariants.price} ASC, ${productVariants.id} ASC
      )`.as('pick_rank'),
    })
    .from(productVariants)
    .as('product_variant_ranked')

  return db
    .select({
      productId: ranked.productId,
      displayPrice: ranked.price,
      displayOriginalPrice: ranked.originalPrice,
      soldOut: totals.soldOut,
    })
    .from(ranked)
    .innerJoin(totals, eq(totals.productId, ranked.productId))
    .where(eq(ranked.pickRank, 1))
    .as('product_variant_summary')
}

/**
 * 商品级派生查询：商品标识 + 展示价 + 展示原价 + 售罄状态。
 * 外层没有 GROUP BY，Phase 3 可继续 .where() / .orderBy() 组合筛选与排序。
 *
 * 使用 INNER JOIN 依赖 D49 的不变量：每件商品至少有一个有效组合
 * （由种子校验保证）。没有组合的商品不会出现在结果里。
 */
function productSummaryQuery (db: Database) {
  const summary = productVariantSummary(db)
  return db
    .select({
      productId: products.id,
      slug: products.slug,
      name: products.name,
      displayPrice: summary.displayPrice,
      displayOriginalPrice: summary.displayOriginalPrice,
      soldOut: summary.soldOut,
    })
    .from(products)
    .innerJoin(summary, eq(summary.productId, products.id))
}

/** 执行派生查询；可按商品 id 或 slug 过滤。 */
export async function selectProductSummaries (
  db: Database,
  filter: ProductSummaryFilter = {},
): Promise<ProductSummary[]> {
  const conditions: SQL[] = []
  if (filter.productIds !== undefined) {
    if (filter.productIds.length === 0) return []
    conditions.push(inArray(products.id, filter.productIds))
  }
  if (filter.slugs !== undefined) {
    if (filter.slugs.length === 0) return []
    conditions.push(inArray(products.slug, filter.slugs))
  }

  const query = productSummaryQuery(db)
  if (conditions.length === 0) return query
  return query.where(and(...conditions))
}
