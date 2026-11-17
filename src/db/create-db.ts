import { describeConfig, loadConfig } from '../config.ts'
import { runIfMain } from '../run-if-main.ts'
import { createDatabase } from './create-database.ts'

async function main (): Promise<void> {
  const config = loadConfig()
  console.log(`[db:create] 目标：${describeConfig(config)}`)

  const definition = await createDatabase(config)
  console.log(`[db:create] 实际定义：${definition.name} ${definition.characterSet} / ${definition.collation}`)

  if (definition.characterSet !== 'utf8mb4' || definition.collation !== 'utf8mb4_0900_ai_ci') {
    console.error('[db:create] 数据库已存在，但字符集或排序规则不符合要求（utf8mb4 / utf8mb4_0900_ai_ci）。')
    process.exitCode = 1
  }
}

await runIfMain(import.meta.url, main)
