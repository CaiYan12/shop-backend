import { Type } from 'typebox'
import type { AppInstance } from '../app.ts'
import { selectPurchaseProduct, selectPurchaseVariant } from '../db/purchase-check.ts'
import { AppError } from '../errors.ts'
import { yuanToCents } from '../money.ts'
import { PurchaseCheckBody } from '../schemas/product.ts'

/**
 * 购买校验路由（D58、D63）：对单件商品的所选规格组合与数量做可购买性判断，
 * 只校验不写库；金额恒按当前数据库价格计算。
 */
export function registerPurchaseCheckRoutes (app: AppInstance): void {
  app.post('/api/purchase-check', {
    schema: {
      operationId: 'checkPurchase',
      tags: ['购买校验'],
      body: PurchaseCheckBody,
      response: {
        200: Type.Ref('PurchaseCheckResponse'),
        400: Type.Ref('ErrorResponse'),
        404: Type.Ref('ErrorResponse'),
        409: Type.Ref('ErrorResponse'),
        413: Type.Ref('ErrorResponse'),
        415: Type.Ref('ErrorResponse'),
        500: Type.Ref('ErrorResponse'),
      },
    },
  }, async (request) => {
    const { slug, sku, quantity, expectedUnitPriceCents } = request.body

    // 判定顺序：商品 → 规格归属 → 库存 → 价格（D63）。
    const product = await selectPurchaseProduct(app.db, slug)
    if (product === null) {
      throw new AppError('PRODUCT_NOT_FOUND', '商品不存在。')
    }

    const variant = await selectPurchaseVariant(app.db, sku)
    if (variant === null) {
      throw new AppError('VARIANT_NOT_FOUND', '规格组合不存在。')
    }
    if (variant.productId !== product.productId) {
      throw new AppError('VARIANT_NOT_IN_PRODUCT', '规格组合不属于该商品。')
    }

    // 金额恒按当前数据库价格计算（D63）；整数分相乘在安全整数范围内（D68）。
    const unitPriceCents = yuanToCents(variant.price)
    const subtotalCents = unitPriceCents * quantity
    const priceChanged = expectedUnitPriceCents !== undefined && expectedUnitPriceCents !== unitPriceCents

    const sharedResultFields = {
      product: { slug: product.slug, name: product.name },
      variant: {
        sku: variant.sku,
        option1Value: variant.option1Value,
        option2Value: variant.option2Value,
      },
      quantity,
      unitPriceCents,
      subtotalCents,
      stock: variant.stock,
      priceChanged,
    }

    // 库存不足优先作原因；priceChanged 独立布尔，两者可同时为真（D63）。
    if (quantity > variant.stock) {
      return { result: 'blocked' as const, reason: 'INSUFFICIENT_STOCK' as const, ...sharedResultFields }
    }

    // 价格变化阻止通过，返回请求价与当前价，待用户确认后再次校验（D63）。
    if (priceChanged) {
      return {
        result: 'blocked' as const,
        reason: 'PRICE_CHANGED' as const,
        ...sharedResultFields,
        requestedUnitPriceCents: expectedUnitPriceCents,
      }
    }

    return { result: 'purchasable' as const, ...sharedResultFields }
  })
}
