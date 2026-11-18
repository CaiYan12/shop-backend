import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRODUCT_INDEX_DEFINITION,
  productIndexName,
  productIndexVersion,
} from '../src/search/index-mapping.ts'

test('映射符合 D74：smartcn 检索字段、keyword 标识、long 金额、1 分片 0 副本', () => {
  const properties = PRODUCT_INDEX_DEFINITION.mappings.properties
  assert.deepEqual(PRODUCT_INDEX_DEFINITION.settings, {
    number_of_shards: 1,
    number_of_replicas: 0,
  })
  for (const field of ['name', 'brand', 'model']) {
    assert.deepEqual(properties[field], { type: 'search_as_you_type', analyzer: 'smartcn' })
  }
  assert.deepEqual(properties.categoryName, { type: 'text', analyzer: 'smartcn' })
  assert.deepEqual(properties.slug, { type: 'keyword' })
  assert.deepEqual(properties.categorySlug, { type: 'keyword' })
  assert.deepEqual(properties.productId, { type: 'integer' })
  assert.deepEqual(properties.sales, { type: 'integer' })
  assert.deepEqual(properties.displayPriceCents, { type: 'long' })
})

test('物理索引名与版本号互转', () => {
  assert.equal(productIndexName(1), 'products_v1')
  assert.equal(productIndexName(12), 'products_v12')
  assert.equal(productIndexVersion('products_v3'), 3)
  assert.equal(productIndexVersion('products'), null)
  assert.equal(productIndexVersion('products_vx'), null)
  assert.throws(() => productIndexName(0), /版本必须是正整数/)
})

test('物理索引前缀可配置：默认 products_v 不变，自定义前缀用于隔离重建', () => {
  assert.equal(productIndexName(3, 'products_es_test_rebuild_v'), 'products_es_test_rebuild_v3')
  assert.equal(productIndexVersion('products_es_test_rebuild_v3', 'products_es_test_rebuild_v'), 3)
  assert.equal(productIndexVersion('products_es_test_rebuild_v3'), null)
})
