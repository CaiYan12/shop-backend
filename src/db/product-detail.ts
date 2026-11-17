import { asc, eq } from 'drizzle-orm'
import type { Database } from './client.ts'
import {
  categories,
  productImages,
  products,
  productVariants,
  type DetailBlock,
  type DimensionMetadata,
} from './schema.ts'

/** 详情页的商品主体：卡片字段、规格维度与图文详情。 */
export interface ProductDetailRow {
  productId: number
  slug: string
  name: string
  brand: string
  model: string
  categorySlug: string
  categoryName: string
  rating: number
  sales: number
  dimensions: DimensionMetadata[]
  detail: DetailBlock[]
}

/** 详情页的一张图片；封面图取其中第一张。 */
export interface ProductImageRow {
  path: string
  alt: string
}

/** 详情页的一个规格组合；金额为元，由路由层统一转整数分（D59）。 */
export interface ProductVariantRow {
  sku: string
  option1Value: string
  option2Value: string
  price: number
  originalPrice: number
  stock: number
}

/** 按 slug 取商品主体；商品不存在时返回 null。 */
export async function selectProductDetail (
  db: Database,
  slug: string,
): Promise<ProductDetailRow | null> {
  const [row] = await db
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
      dimensions: products.dimensions,
      detail: products.detail,
    })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(eq(products.slug, slug))

  return row ?? null
}

/** 轮播图：按 sort_order 升序、同序按 id 升序（D67）。 */
export async function selectProductImages (
  db: Database,
  productId: number,
): Promise<ProductImageRow[]> {
  return db
    .select({
      path: productImages.path,
      alt: productImages.alt,
    })
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(asc(productImages.sortOrder), asc(productImages.id))
}

/** 规格组合：按 id 升序（D67）；缺货组合同样返回，库存为 0。 */
export async function selectProductVariants (
  db: Database,
  productId: number,
): Promise<ProductVariantRow[]> {
  return db
    .select({
      sku: productVariants.sku,
      option1Value: productVariants.option1Value,
      option2Value: productVariants.option2Value,
      price: productVariants.price,
      originalPrice: productVariants.originalPrice,
      stock: productVariants.stock,
    })
    .from(productVariants)
    .where(eq(productVariants.productId, productId))
    .orderBy(asc(productVariants.id))
}
