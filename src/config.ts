import { config as loadDotenv } from 'dotenv'
import { resolve } from 'node:path'
import { BACKEND_ROOT } from './backend-root.ts'

/**
 * 配置的单一入口：迁移、种子、服务与测试都从这里读取同一份配置（D53）。
 *
 * 优先级：进程环境变量 > .env > 程序默认值。
 * dotenv 默认不覆盖已存在的键，因此「进程环境变量优先」由它保证。
 */

export const DEFAULT_PORT = 3001

/** Elasticsearch 默认地址（Phase 4）；可用 ES_URL 覆盖。 */
export const DEFAULT_ES_URL = 'http://127.0.0.1:9201'

/** 必须显式提供的配置项；DB_PASSWORD 允许为空（本地无口令账户）。 */
export const REQUIRED_ENV_KEYS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME'] as const

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
  /** Elasticsearch 节点地址；搜索与索引重建共用。 */
  esUrl: string
}

/**
 * 默认 .env 位置：仓库根，与 BACKEND_ROOT 同源。
 * 不按 process.cwd() 解析，因此从任何工作目录启动都读到同一份 .env。
 */
const DEFAULT_ENV_FILE = resolve(BACKEND_ROOT, '.env')

export interface LoadConfigOptions {
  /** 待填充的环境变量对象；默认 process.env。 */
  env?: NodeJS.ProcessEnv
  /** .env 文件路径；默认仓库根的 .env。 */
  envFile?: string
}

function parsePort (raw: string, key: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError(`${key} 必须是 1–65535 的整数，当前值无法使用。`)
  }
  return value
}

/** 校验 ES_URL：缺省为本地 9201，只接受 http/https。 */
function parseEsUrl (raw: string | undefined): string {
  const value = raw?.trim()
  if (value === undefined || value === '') return DEFAULT_ES_URL
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError('ES_URL 不是合法的 URL。')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('ES_URL 必须以 http:// 或 https:// 开头。')
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
    esUrl: parseEsUrl(env.ES_URL),
  }
}

/** 读取 .env（不覆盖已有进程环境变量）后校验并返回配置。 */
export function loadConfig (options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env
  const envFile = options.envFile ?? DEFAULT_ENV_FILE
  loadDotenv({ path: envFile, processEnv: env, quiet: true })
  return readConfig(env)
}

/** 供日志使用的连接摘要：只含主机、端口、用户、库名与密码是否已设置。 */
export function describeConfig (config: AppConfig): string {
  const passwordState = config.db.password === '' ? '未设置' : '已设置'
  return `mysql://${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}（密码${passwordState}，服务端口 ${config.port}）`
}
