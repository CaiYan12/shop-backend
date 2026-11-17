import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, DEFAULT_PORT, describeConfig, loadConfig, readConfig } from '../src/config.ts'

const baseEnv = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_USER: 'shop_app',
  DB_PASSWORD: 'p@ss-not-in-log',
  DB_NAME: 'shop_homework',
}

function withTempEnvFile (contents: string): { dir: string, envFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shop-config-'))
  const envFile = join(dir, '.env')
  writeFileSync(envFile, contents, 'utf8')
  return { dir, envFile }
}

test('缺少必要配置时报错，并逐项指明缺哪个', () => {
  assert.throws(
    () => readConfig({}),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME']) {
        assert.match(error.message, new RegExp(key))
      }
      return true
    },
  )
})

test('只缺一项时错误只点名这一项', () => {
  const { DB_NAME: _missing, ...partial } = baseEnv
  assert.throws(
    () => readConfig(partial),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.match(error.message, /DB_NAME/)
      assert.doesNotMatch(error.message, /DB_HOST/)
      return true
    },
  )
})

test('错误信息不包含密码', () => {
  const { DB_NAME: _missing, ...partial } = baseEnv
  assert.throws(
    () => readConfig(partial),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.ok(!error.message.includes(baseEnv.DB_PASSWORD))
      return true
    },
  )
})

test('DB_PORT 非法时报错且不泄露密码', () => {
  assert.throws(
    () => readConfig({ ...baseEnv, DB_PORT: 'not-a-port' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.match(error.message, /DB_PORT/)
      assert.ok(!error.message.includes(baseEnv.DB_PASSWORD))
      return true
    },
  )
})

test('完整配置解析出数据库连接参数，PORT 缺省为程序默认值', () => {
  const config = readConfig(baseEnv)
  assert.deepEqual(config.db, {
    host: '127.0.0.1',
    port: 3306,
    user: 'shop_app',
    password: baseEnv.DB_PASSWORD,
    database: 'shop_homework',
  })
  assert.equal(config.port, DEFAULT_PORT)
})

test('PORT 优先级：进程环境变量 > .env > 程序默认', () => {
  const { dir, envFile } = withTempEnvFile('PORT=4001\n')
  try {
    assert.equal(loadConfig({ env: { ...baseEnv }, envFile }).port, 4001)
    assert.equal(loadConfig({ env: { ...baseEnv, PORT: '5001' }, envFile }).port, 5001)
    assert.equal(loadConfig({ env: { ...baseEnv }, envFile: join(dir, 'absent.env') }).port, DEFAULT_PORT)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadConfig 从 .env 补齐数据库配置', () => {
  const { dir, envFile } = withTempEnvFile(
    'DB_HOST=db.example\nDB_PORT=3307\nDB_USER=shop_app\nDB_PASSWORD=p@ss-not-in-log\nDB_NAME=shop_homework\n',
  )
  try {
    const config = loadConfig({ env: {}, envFile })
    assert.equal(config.db.host, 'db.example')
    assert.equal(config.db.port, 3307)
    assert.equal(config.db.database, 'shop_homework')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('describeConfig 输出连接摘要但不含密码', () => {
  const config = readConfig(baseEnv)
  const text = describeConfig(config)
  assert.ok(!text.includes(baseEnv.DB_PASSWORD))
  assert.match(text, /shop_homework/)
  assert.match(text, /127\.0\.0\.1:3306/)
})
