import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from 'mysql2/promise'
import { createApp, type AppInstance } from '../src/app.ts'
import { createDb, createPool, type Database } from '../src/db/client.ts'
import { runMigrations } from '../src/db/migrate.ts'
import { seedDatabase } from '../src/db/seed.ts'
import { loadTestConfig } from './helpers/test-config.ts'

const config = loadTestConfig()
let pool: Pool
let db: Database
let app: AppInstance

before(async () => {
  pool = createPool(config)
  db = createDb(pool)
  await runMigrations(db)
  await seedDatabase(db)
  app = await createApp({ db, config })
  await app.ready()
})

after(async () => {
  await app.close()
  await pool.end()
})

interface CategoryItem {
  slug: string
  name: string
}

interface CategoriesBody {
  items?: CategoryItem[]
}

async function categories (): Promise<{ status: number, body: CategoriesBody }> {
  const response = await app.inject({ method: 'GET', url: '/api/categories' })
  return { status: response.statusCode, body: response.json() }
}

test('返回四个商品类型，含 slug 与 name，响应体不含未确认字段', async () => {
  const { status, body } = await categories()
  assert.equal(status, 200)
  // 种子清单的四类；deepEqual 同时保证每项只有 slug 与 name、顶层只有 items。
  assert.deepEqual(body, {
    items: [
      { slug: 'audio', name: '音频设备' },
      { slug: 'peripherals', name: '键盘外设' },
      { slug: 'displays', name: '显示设备' },
      { slug: 'wearables', name: '智能穿戴' },
    ],
  })
})

test('按 id 升序：后插入的商品类型排在最后，与 slug、name 的字典序无关', async () => {
  // 探针的 slug 与 name 都排在种子四类之前；若按 slug 或 name 排序会出现在首位。
  await pool.query("INSERT INTO categories (slug, name) VALUES ('aaa-probe', '0 探针类型')")
  try {
    const { status, body } = await categories()
    assert.equal(status, 200)
    assert.deepEqual(body.items?.map((item) => item.slug), [
      'audio',
      'peripherals',
      'displays',
      'wearables',
      'aaa-probe',
    ])
  } finally {
    await pool.query("DELETE FROM categories WHERE slug = 'aaa-probe'")
  }
})

test('商品类型不返回商品数量等未确认字段', async () => {
  const { status, body } = await categories()
  assert.equal(status, 200)
  assert.equal(body.items?.length, 4)
  for (const item of body.items ?? []) {
    assert.deepEqual(Object.keys(item).sort(), ['name', 'slug'])
  }

  const [row] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS total FROM categories WHERE slug = 'audio'",
  )
  assert.equal(Number(row[0]!.total), 1, '种子商品类型 audio 存在')
})
