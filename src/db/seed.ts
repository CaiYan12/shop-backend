import { and, eq, notInArray } from 'drizzle-orm'
import { describeConfig, loadConfig } from '../config.ts'
import { runIfMain } from '../run-if-main.ts'
import { createDb, createPool, type Database } from './client.ts'
import { SEED_MANIFEST } from './seed-data.ts'
import { validateManifest, type SeedManifest } from './seed-manifest.ts'
import { categories, productImages, products, productVariants } from './schema.ts'

export interface SeedResult {
  categories: number
  products: number
  variants: number
  images: number
}

/**
 * 按稳定键导入种子数据（D52）：
 * - 商品类型、商品按 slug upsert，规格组合按 sku upsert，图片按商品整体替换；
 * - 本次清单中已移除的规格组合被删除（D52）；
 * - 未出现在本次清单里的商品与商品类型保持不动，因此支持分批导入；
 * - 普通导入使用单事务，任一步失败整体回滚。
 */
export async function seedDatabase (
  db: Database,
  manifest: SeedManifest = SEED_MANIFEST,
): Promise<SeedResult> {
  validateManifest(manifest)

  return db.transaction(async (tx) => {
    for (const category of manifest.categories) {
      await tx
        .insert(categories)
        .values({ slug: category.slug, name: category.name })
        .onDuplicateKeyUpdate({ set: { name: category.name } })
    }

    let imageCount = 0
    let variantCount = 0
    for (const product of manifest.products) {
      const [category] = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.slug, product.categorySlug))
      if (category === undefined) {
        throw new Error(
          `商品 ${product.slug} 引用的商品类型 ${product.categorySlug} 不在库中，也不在本次清单里`,
        )
      }

      const values = {
        slug: product.slug,
        name: product.name,
        categoryId: category.id,
        brand: product.brand,
        model: product.model,
        rating: product.rating,
        sales: product.sales,
        detail: product.detail,
        dimensions: product.dimensions,
      }
      await tx
        .insert(products)
        .values(values)
        .onDuplicateKeyUpdate({
          set: {
            name: values.name,
            categoryId: values.categoryId,
            brand: values.brand,
            model: values.model,
            rating: values.rating,
            sales: values.sales,
            detail: values.detail,
            dimensions: values.dimensions,
          },
        })

      const [stored] = await tx
        .select({ id: products.id })
        .from(products)
        .where(eq(products.slug, product.slug))
      if (stored === undefined) {
        throw new Error(`商品 ${product.slug} 写入后未能读回`)
      }

      await tx.delete(productImages).where(eq(productImages.productId, stored.id))
      await tx.insert(productImages).values(
        product.images.map((image, index) => ({
          productId: stored.id,
          path: image.path,
          sortOrder: index + 1,
          alt: image.alt,
        })),
      )
      imageCount += product.images.length

      for (const variant of product.variants) {
        const variantValues = {
          productId: stored.id,
          sku: variant.sku,
          option1Value: variant.option1Value,
          option2Value: variant.option2Value,
          price: variant.price,
          originalPrice: variant.originalPrice,
          stock: variant.stock,
        }
        await tx
          .insert(productVariants)
          .values(variantValues)
          .onDuplicateKeyUpdate({
            set: {
              // 必须带上 sku：清单改 sku 而选项对不变时，INSERT 会撞上选项唯一索引，
              // 若不更新 sku，随后的「删除清单外组合」会把这行删掉，组合静默消失。
              sku: variantValues.sku,
              productId: variantValues.productId,
              option1Value: variantValues.option1Value,
              option2Value: variantValues.option2Value,
              price: variantValues.price,
              originalPrice: variantValues.originalPrice,
              stock: variantValues.stock,
            },
          })
      }

      // 删除本次清单中已移除的组合；清单至少有一个组合，因此 notInArray 不会退化为空条件。
      await tx
        .delete(productVariants)
        .where(and(
          eq(productVariants.productId, stored.id),
          notInArray(productVariants.sku, product.variants.map((variant) => variant.sku)),
        ))
      variantCount += product.variants.length
    }

    return {
      categories: manifest.categories.length,
      products: manifest.products.length,
      variants: variantCount,
      images: imageCount,
    }
  })
}

async function main (): Promise<void> {
  const config = loadConfig()
  console.log(`[seed] 目标：${describeConfig(config)}`)
  const pool = createPool(config)
  try {
    const db = createDb(pool)
    const result = await seedDatabase(db)
    console.log(
      `[seed] 完成：商品类型 ${result.categories} 个、商品 ${result.products} 件、规格组合 ${result.variants} 个、图片 ${result.images} 张。`,
    )
  } finally {
    await pool.end()
  }
}

await runIfMain(import.meta.url, main)
