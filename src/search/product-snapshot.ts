import { asc, eq } from 'drizzle-orm'
import type { Database } from '../db/client.ts'
import { selectProductSummaries } from '../db/product-summary.ts'
import { categories, products } from '../db/schema.ts'
import { yuanToCents } from '../money.ts'

/**
 * 写入 Elasticsearch 的商品文档（ADR 0002）：
 * 只含检索文本、稳定标识与筛选排序字段；展示字段由 MySQL 在查询时补齐。
 */
export interface ProductSearchDocument {
  productId: number
  slug: string
  name: string
  brand: string
  model: string
  categoryName: string
  categorySlug: string
  sales: number
  displayPriceCents: number
}

/**
 * 从 MySQL 读全量快照，供重建脚本 bulk 导入。
 *
 * 展示价不在这里另算：直接复用 src/db/product-summary.ts 的派生查询，
 * 再用 yuanToCents 把元转成整数分（D59），保证与列表接口同一套规则。
 */
export async function loadProductSnapshot (db: Database): Promise<ProductSearchDocument[]> {
  const rows = await db
    .select({
      productId: products.id,
      slug: products.slug,
      name: products.name,
      brand: products.brand,
      model: products.model,
      categoryName: categories.name,
      categorySlug: categories.slug,
      sales: products.sales,
    })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .orderBy(asc(products.id))

  const summaries = await selectProductSummaries(db)
  const summaryByProductId = new Map(summaries.map((summary) => [summary.productId, summary]))

  return rows.map((row) => {
    const summary = summaryByProductId.get(row.productId)
    if (summary === undefined) {
      throw new Error(`商品 ${row.slug} 没有可用的规格组合摘要，拒绝用不完整快照重建索引。`)
    }
    return {
      ...row,
      displayPriceCents: yuanToCents(summary.displayPrice),
    }
  })
}
