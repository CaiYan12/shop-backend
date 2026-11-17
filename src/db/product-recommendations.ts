import { asc, desc, eq, ne, sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import { categories, products } from './schema.ts'

/** 相关推荐的一件候选商品（D66）：卡片字段与展示价由路由层补齐。 */
export interface ProductRecommendationCandidate {
  productId: number
  slug: string
  name: string
  brand: string
  model: string
  categorySlug: string
  categoryName: string
  rating: number
  sales: number
}

/**
 * 相关推荐候选（D66）：排除当前商品，同类优先，其次销量降序、同销量 id 升序。
 * 候选不足时自然由其他商品类型补足，不按当前数据规模写死。
 * 当前商品不存在时返回 null，由路由映射为 PRODUCT_NOT_FOUND。
 */
export async function selectProductRecommendations (
  db: Database,
  slug: string,
  limit: number,
): Promise<ProductRecommendationCandidate[] | null> {
  const [current] = await db
    .select({
      productId: products.id,
      categoryId: products.categoryId,
    })
    .from(products)
    .where(eq(products.slug, slug))

  if (current === undefined) return null

  return db
    .select({
      productId: products.id,
      slug: products.slug,
      name: products.name,
      brand: products.brand,
      model: products.model,
      categorySlug: categories.slug,
      categoryName: categories.name,
      rating: products.rating,
      sales: products.sales,
    })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(ne(products.id, current.productId))
    .orderBy(
      // 同类优先：同类为 1、其他为 0，降序即同类在前（D66）。
      desc(sql`${products.categoryId} = ${current.categoryId}`),
      desc(products.sales),
      asc(products.id),
    )
    .limit(limit)
}
