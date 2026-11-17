import { config as loadDotenv } from 'dotenv'
import { resolve } from 'node:path'

/**
 * 配置的单一入口：迁移、种子、服务与测试都从这里读取同一份配置（D53）。
 *
 * 优先级：进程环境变量 > .env > 程序默认值。
 * dotenv 默认不覆盖已存在的键，因此「进程环境变量优先」由它保证。
 */

export const DEFAULT_PORT = 3001
export const DEFAULT_DB_PORT = 3306

/** 必须显式提供的配置项；DB_PASSWORD 允许为空（本地无口令账户）。 */
export const REQUIRED_ENV_KEYS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME'] as const

export type RequiredEnvKey = (typeof REQUIRED_ENV_KEYS)[number]

export class ConfigError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export interface DbConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export interface AppConfig {
  db: DbConfig
  port: number
}

export interface LoadConfigOptions {
  /** 待填充的环境变量对象；默认 process.env。 */
  env?: NodeJS.ProcessEnv
  /** .env 文件路径；默认从当前工作目录解析。 */
  envFile?: string
}

function parsePort (raw: string, key: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError(`${key} 必须是 1–65535 的整数，当前值无法使用。`)
  }
  return value
}

/** 只做校验与解析，不读文件；便于测试与复用。 */
export function readConfig (env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing = REQUIRED_ENV_KEYS.filter((key) => !env[key]?.trim())
  if (missing.length > 0) {
    throw new ConfigError(
      `缺少必要的环境变量：${missing.join('、')}。请复制 .env.example 为 .env 并填写。`,
    )
  }

  const rawPort = env.PORT?.trim()
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : parsePort(rawPort, 'PORT')

  return {
    db: {
      host: env.DB_HOST!.trim(),
      port: parsePort(env.DB_PORT!.trim(), 'DB_PORT'),
      user: env.DB_USER!.trim(),
      password: env.DB_PASSWORD ?? '',
      database: env.DB_NAME!.trim(),
    },
    port,
  }
}

/** 读取 .env（不覆盖已有进程环境变量）后校验并返回配置。 */
export function loadConfig (options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env
  const envFile = options.envFile ?? resolve(process.cwd(), '.env')
  loadDotenv({ path: envFile, processEnv: env, quiet: true })
  return readConfig(env)
}

/** 供日志使用的连接摘要：只含主机、端口、用户、库名与密码是否已设置。 */
export function describeConfig (config: AppConfig): string {
  const passwordState = config.db.password === '' ? '未设置' : '已设置'
  return `mysql://${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}（密码${passwordState}，服务端口 ${config.port}）`
}
