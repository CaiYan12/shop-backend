import { eq } from 'drizzle-orm'
import type { Database } from './client.ts'
import { products, productVariants } from './schema.ts'

/** 购买校验的商品主体：只取判断与回显所需字段（D63）。 */
export interface PurchaseProductRow {
  productId: number
  slug: string
  name: string
}

/** 购买校验的规格组合：金额为元，由路由层统一转整数分（D59）。 */
export interface PurchaseVariantRow {
  productId: number
  sku: string
  option1Value: string
  option2Value: string
  price: number
  stock: number
}

/** 按 slug 取商品；商品不存在时返回 null。 */
export async function selectPurchaseProduct (
  db: Database,
  slug: string,
): Promise<PurchaseProductRow | null> {
  const [row] = await db
    .select({
      productId: products.id,
      slug: products.slug,
      name: products.name,
    })
    .from(products)
    .where(eq(products.slug, slug))

  return row ?? null
}

/**
 * 按 sku 取规格组合；规格组合不存在时返回 null。
 * 这里刻意不按商品过滤：归属不符要返回可区分的 VARIANT_NOT_IN_PRODUCT（D62）。
 */
export async function selectPurchaseVariant (
  db: Database,
  sku: string,
): Promise<PurchaseVariantRow | null> {
  const [row] = await db
    .select({
      productId: productVariants.productId,
      sku: productVariants.sku,
      option1Value: productVariants.option1Value,
      option2Value: productVariants.option2Value,
      price: productVariants.price,
      stock: productVariants.stock,
    })
    .from(productVariants)
    .where(eq(productVariants.sku, sku))

  return row ?? null
}
