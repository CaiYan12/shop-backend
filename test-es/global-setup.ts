import { createDatabase } from '../src/db/create-database.ts'
import { loadTestConfig } from '../test/helpers/test-config.ts'

/**
 * `pnpm test:es` 的全局前置（#25）：
 * 1. 真实 Elasticsearch 必须可达，否则给出明确指引并以非零码退出（不静默跳过）；
 * 2. 重建 `shop_homework_test`，保证一致性矩阵从已知种子开始。
 */
async function assertElasticsearchReady (url: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(3_000) })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Elasticsearch 不可达（${url}）：${reason}。\n` +
      'pnpm test:es 需要真实 Elasticsearch（#25）。请先运行 `node scripts/es-dev.mjs`' +
      '（约 30–36 s 就绪），并确保 ES_URL 指向该实例（默认 http://127.0.0.1:9201）。',
    )
  }
  if (!response.ok) {
    throw new Error(
      `Elasticsearch 根路径返回 HTTP ${response.status}（${url}）。` +
      '请确认 9201 端口上运行的是 Elasticsearch，而不是其他服务。',
    )
  }
  const body = await response.json() as { version?: { number?: unknown } }
  const version = body.version?.number
  if (typeof version !== 'string') {
    throw new Error(`${url} 的响应不是 Elasticsearch 根信息（缺少 version.number）。`)
  }
  return version
}

export async function globalSetup (): Promise<void> {
  const config = loadTestConfig()
  const version = await assertElasticsearchReady(config.esUrl)
  await createDatabase(config, { drop: true })
  console.log(
    `[test:es] Elasticsearch ${version} 可用（${config.esUrl}）；` +
    `测试库 ${config.db.database} 已重建。测试索引使用 products_es_test*，不触碰演示别名 products。`,
  )
}
