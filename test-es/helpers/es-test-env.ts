import { PRODUCTS_ALIAS, productIndexVersion } from '../../src/search/index-mapping.ts'
import { loadTestConfig } from '../../test/helpers/test-config.ts'

/**
 * 真实 ES 验收测试的隔离命名（#25）。
 *
 * 演示别名 `products` 与演示物理索引 `products_vN` 一概不碰：
 * 测试索引不使用 `products_v` 前缀，别名也不叫 `products`，
 * 因此重建脚本的 `products_v*` 扫描与演示搜索都不会看到测试索引。
 */
export const TEST_INDEX = 'products_es_test'
export const TEST_ALIAS = 'products_es_test_alias'

/** 超 32 位金额用例单独用一个索引，避免测试之间互相影响。 */
export const LONG_AMOUNT_INDEX = 'products_es_test_amount'
export const LONG_AMOUNT_ALIAS = 'products_es_test_amount_alias'

/** 演示别名（ADR 0003）；只用于「测试没有动它」的核对，绝不读写。 */
export const DEMO_ALIAS = PRODUCTS_ALIAS

/** 测试统一从同一份配置取 ES 地址（ES_URL 覆盖，默认 127.0.0.1:9201）。 */
export function testEsUrl (): string {
  return loadTestConfig().esUrl
}

/** 测试索引名必须与演示索引命名空间分离；写错名称时立刻失败。 */
export function isIsolatedIndexName (index: string): boolean {
  return productIndexVersion(index) === null && index.startsWith('products_es_test')
}
