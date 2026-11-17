import { defineConfig } from 'drizzle-kit'
import { loadConfig } from './src/config.ts'
import { DB_CASING } from './src/db/casing.ts'

const config = loadConfig()

export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  casing: DB_CASING,
  dbCredentials: {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  },
})
