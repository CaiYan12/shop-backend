import { createDatabase } from '../src/db/create-database.ts'
import { loadTestConfig } from './helpers/test-config.ts'

/** 每次运行前重建 shop_homework_test（utf8mb4 + utf8mb4_0900_ai_ci），保证从空库开始。 */
export async function globalSetup (): Promise<void> {
  await createDatabase(loadTestConfig(), { drop: true })
}
