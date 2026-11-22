import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { terminateLauncher } from '../scripts/es-launcher.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const FAKE_HOME = join(HERE, 'fixtures', 'fake-es')
const WINDOWS = process.platform === 'win32'
const OPTIONS = { skip: WINDOWS ? false : 'Windows 专属：需要 taskkill / PowerShell 进程查询', timeout: 30000 }

function makeSandbox () {
  const dir = mkdtempSync(join(tmpdir(), 'es-lifecycle-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  for (const file of ['es-dev.mjs', 'es-ownership.mjs', 'es-launcher.mjs']) {
    copyFileSync(join(REPO, 'scripts', file), join(dir, 'scripts', file))
  }
  return dir
}

function makeEnv (sandbox, port, token) {
  return {
    ES_HOME: FAKE_HOME,
    ES_HTTP_PORT: String(port),
    ES_READY_TIMEOUT_MS: '3000',
    ES_DATA_DIR: join(sandbox, 'data'),
    ES_LOG_DIR: join(sandbox, 'logs'),
    ES_PROVENANCE_FILE: join(sandbox, 'provenance.json'),
    ES_LIFECYCLE_MARKER: join(sandbox, 'launcher-started.txt'),
    ES_LIFECYCLE_TOKEN: token,
  }
}

function runEsDev (sandbox, env, timeoutMs = 20000) {
  const child = spawn(process.execPath, [join(sandbox, 'scripts', 'es-dev.mjs')], {
    cwd: sandbox,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let launcherResolved = false
  let resolveLauncher = () => {}
  const launcher = new Promise((resolve) => { resolveLauncher = resolve })
  const scanLauncher = () => {
    if (launcherResolved) return
    const match = stdout.match(/启动器 PID (\d+)/)
    if (!match) return
    launcherResolved = true
    resolveLauncher(Number(match[1]))
  }
  child.stdout.on('data', (chunk) => { stdout += chunk; scanLauncher() })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: null, timedOut: true, stdout, stderr })
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, timedOut: false, stdout, stderr })
    })
  })
  return { child, done, launcher }
}

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function waitFor (check, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(100)
  }
  throw new Error('等待超时：' + label)
}

function processExists (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const result = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  return !/No tasks are running|INFO: No tasks/i.test(result.stdout ?? '')
}

function tokenProcesses (token) {
  const command = '$ErrorActionPreference="Stop"; Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like \'*' + token + '*\' } | Select-Object -ExpandProperty ProcessId'
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
  return (result.stdout ?? '').split(/\s+/).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
}

function killPidTree (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

/** finally 只用启动时记录的身份清理；身份已缺失或已退出时不做裸 PID taskkill。 */
function cleanupLauncher (pid, identity) {
  if (!Number.isInteger(pid) || identity === null || !processExists(pid)) return
  let actual = null
  try {
    actual = processIdentity(pid)
  } catch {
    return
  }
  terminateLauncher({
    launcherPid: pid,
    identity,
    actual,
    kill: () => killPidTree(pid),
    log: () => {},
  })
}

function killToken (token) {
  for (const pid of tokenProcesses(token)) killPidTree(pid)
}

function readProvenance (sandbox) {
  const path = join(sandbox, 'provenance.json')
  assert.equal(existsSync(path), true, 'provenance 未写入：' + path)
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function freePort () {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : null
  await new Promise((resolve) => server.close(resolve))
  if (!Number.isInteger(port)) throw new Error('无法分配测试端口')
  return port
}

async function portFree (port) {
  return new Promise((resolve) => {
    const socket = createServer()
    socket.once('error', () => resolve(false))
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolve(true)))
  })
}

function processIdentity (pid) {
  const command = '$ErrorActionPreference="Stop"; $p=Get-Process -Id ' + pid + '; [pscustomobject]@{ id=$p.Id; startTime=$p.StartTime.ToUniversalTime().ToString(\'o\'); execPath=$p.Path } | ConvertTo-Json -Compress'
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
  assert.equal(result.status, 0, '读取进程身份失败：' + (result.stderr ?? ''))
  const info = JSON.parse(result.stdout.replace(/^\uFEFF/, ''))
  return { pid: info.id, startTime: info.startTime, execPath: info.execPath }
}

test('启动后超时：exit 1、启动器进程树消失、端口空闲、provenance 失败', OPTIONS, async () => {
  const sandbox = makeSandbox()
  const port = await freePort()
  const token = 'es-lifecycle-timeout-' + Date.now()
  let pid = null
  let identity = null
  try {
    const run = runEsDev(sandbox, makeEnv(sandbox, port, token))
    pid = await Promise.race([run.launcher, sleep(5000).then(() => null)])
    assert.ok(Number.isInteger(pid), '未取得启动器 PID')
    identity = processIdentity(pid)
    const result = await run.done
    assert.equal(result.code, 1, 'es-dev 应 exit 1：' + result.stderr)
    await waitFor(() => !processExists(pid), 8000, '启动器进程消失')
    await waitFor(() => portFree(port), 8000, '测试端口空闲')
    await waitFor(() => tokenProcesses(token).length === 0, 8000, 'PowerShell 子进程消失')
    const provenance = readProvenance(sandbox)
    assert.equal(provenance.created, false)
    assert.equal(provenance.failed, true)
    assert.match(String(provenance.reason), /等待 Elasticsearch 就绪超时/)
  } finally {
    cleanupLauncher(pid, identity)
    killToken(token)
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('外部 listener：命中非本次归属，exit 1，外部进程仍存活', OPTIONS, async () => {
  const sandbox = makeSandbox()
  const port = await freePort()
  const token = 'es-lifecycle-external-' + Date.now()
  let pid = null
  let identity = null
  let external = null
  try {
    const run = runEsDev(sandbox, { ...makeEnv(sandbox, port, token), ES_READY_TIMEOUT_MS: '8000' })
    pid = await Promise.race([run.launcher, sleep(5000).then(() => null)])
    assert.ok(Number.isInteger(pid), '未取得启动器 PID')
    identity = processIdentity(pid)
    await waitFor(() => existsSync(join(sandbox, 'launcher-started.txt')), 8000, '假启动器 marker')
    external = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (pathname === '/') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ version: { number: '9.5.6' } }))
        return
      }
      if (pathname === '/_cluster/health') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ status: 'green' }))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
    })
    await new Promise((resolve, reject) => {
      external.once('error', reject)
      external.listen(port, '127.0.0.1', resolve)
    })
    const result = await run.done
    const output = result.stdout + result.stderr
    assert.equal(result.code, 1, 'es-dev 应 exit 1：' + result.stderr)
    assert.match(output, /被外部进程 \d+ 占用，本次不写运行记录/)
    assert.doesNotMatch(output, /等待 Elasticsearch 就绪超时/)
    await waitFor(() => !processExists(pid), 8000, '启动器进程消失')
    assert.equal(external.listening, true, '外部 listener 不应被终止')
    const response = await fetch('http://127.0.0.1:' + port + '/_cluster/health')
    assert.equal(response.status, 200)
  } finally {
    cleanupLauncher(pid, identity)
    if (external !== null) await new Promise((resolve) => external.close(resolve))
    killToken(token)
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('身份不符：真实进程不 taskkill；身份一致后才收尾', OPTIONS, async () => {
  const sandbox = makeSandbox()
  const token = 'es-lifecycle-identity-' + Date.now()
  const marker = join(sandbox, 'launcher-started.txt')
  const child = spawn('cmd.exe', ['/c', join(FAKE_HOME, 'bin', 'elasticsearch.bat')], {
    env: { ...process.env, ES_LIFECYCLE_MARKER: marker, ES_LIFECYCLE_TOKEN: token },
    windowsHide: true,
    stdio: 'ignore',
  })
  let killed = false
  let identity = null
  try {
    await waitFor(() => existsSync(marker), 8000, '假启动器 marker')
    const pid = child.pid
    assert.ok(Number.isInteger(pid))
    const actual = processIdentity(pid)
    identity = actual
    const wrong = { ...actual, startTime: actual.startTime + '-wrong' }
    const skipped = terminateLauncher({
      launcherPid: pid,
      identity: wrong,
      actual,
      kill: () => { killed = true; killPidTree(pid) },
      log: () => {},
    })
    assert.equal(skipped.killed, false)
    assert.equal(skipped.reason, 'identity-mismatch')
    assert.equal(killed, false, '身份不符时不得调用 kill')
    assert.equal(processExists(pid), true, '身份不符时进程应保留')

    const terminated = terminateLauncher({
      launcherPid: pid,
      identity: actual,
      actual,
      kill: () => { killed = true; killPidTree(pid) },
      log: () => {},
    })
    assert.equal(terminated.killed, true)
    assert.equal(killed, true)
    await waitFor(() => !processExists(pid), 8000, '正确身份后进程消失')
    await waitFor(() => tokenProcesses(token).length === 0, 8000, 'PowerShell 子进程消失')
  } finally {
    cleanupLauncher(child.pid, identity)
    killToken(token)
    rmSync(sandbox, { recursive: true, force: true })
  }
})
