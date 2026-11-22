import test from 'node:test'
import assert from 'node:assert/strict'
import { isOwnedByLaunch, sameProcessIdentity, traceToLauncher, type ProcessRecord } from '../scripts/es-ownership.mjs'

/**
 * P1-B：es-dev 不能把「当前监听 9201 的进程」都当成自己拉起的进程。
 * 归属必须同时满足：PID 等于启动器或是其后代，且可执行路径/命令行
 * 能佐证来自本次的 ES 安装目录。
 */

const HOME = 'D:\\Dev\\elasticsearch-9.5.6'

function lookupOf (entries: ProcessRecord[]): (pid: number) => ProcessRecord | null {
  const map = new Map(entries.map((entry) => [entry.pid, entry]))
  return (pid: number) => map.get(pid) ?? null
}

function launcherRecord (): ProcessRecord {
  return {
    pid: 100,
    parentPid: 40,
    execPath: 'C:\\Windows\\System32\\cmd.exe',
    commandLine: `"C:\\Windows\\System32\\cmd.exe" /c "${HOME}\\bin\\elasticsearch.bat"`,
  }
}

test('监听者是启动器的后代且路径来自 ES 安装目录 → 判定为自己的', () => {
  const lookup = lookupOf([
    launcherRecord(),
    {
      pid: 200,
      parentPid: 100,
      execPath: `${HOME}\\jdk\\bin\\java.exe`,
      commandLine: `java -Des.path.home=${HOME}`,
    },
    {
      pid: 300,
      parentPid: 200,
      execPath: `${HOME}\\jdk\\bin\\java.exe`,
      commandLine: `java -Des.path.home=${HOME}`,
    },
  ])

  assert.equal(traceToLauncher(300, 100, lookup), 'descendant')
  const result = isOwnedByLaunch({ listenerPid: 300, launcherPid: 100, esHome: HOME, lookup })
  assert.equal(result.owned, true)
  assert.equal(result.relation, 'descendant')
})

test('监听者是抢占端口的外部进程 → 判定不是自己的', () => {
  const lookup = lookupOf([
    launcherRecord(),
    {
      pid: 900,
      parentPid: 1,
      execPath: 'C:\\Program Files\\Other\\server.exe',
      commandLine: 'server.exe --port 9201',
    },
  ])

  const result = isOwnedByLaunch({ listenerPid: 900, launcherPid: 100, esHome: HOME, lookup })
  assert.equal(result.owned, false)
  assert.equal(result.relation, null)
})

test('父链中断时即使路径指向 ES 安装目录也判定不归属', () => {
  const lookup = lookupOf([
    {
      pid: 900,
      parentPid: 9999,
      execPath: `${HOME}\\jdk\\bin\\java.exe`,
      commandLine: `java -Des.path.home=${HOME}`,
    },
  ])

  const result = isOwnedByLaunch({ listenerPid: 900, launcherPid: 100, esHome: HOME, lookup })
  assert.equal(result.owned, false, '父链无法上溯到启动器时不得声称归属')
  assert.equal(result.relation, null)
})

test('启动器 PID 自身可作为监听者，但同样需要路径佐证', () => {
  const own = isOwnedByLaunch({
    listenerPid: 100,
    launcherPid: 100,
    esHome: HOME,
    lookup: lookupOf([launcherRecord()]),
  })
  assert.equal(own.owned, true)
  assert.equal(own.relation, 'self')

  const foreign = isOwnedByLaunch({
    listenerPid: 100,
    launcherPid: 100,
    esHome: HOME,
    lookup: lookupOf([{ pid: 100, parentPid: 40, execPath: 'C:\\Other\\cmd.exe', commandLine: 'cmd.exe' }]),
  })
  assert.equal(foreign.owned, false)
})

test('同一进程身份：PID、启动时间、可执行路径三项都一致才成立', () => {
  const recorded = { pid: 100, startTime: '2026-11-22T00:00:00Z', execPath: 'C:\\Windows\\System32\\cmd.exe' }
  assert.equal(sameProcessIdentity(recorded, { ...recorded, execPath: 'c:/windows/system32/CMD.EXE' }), true)
  assert.equal(sameProcessIdentity(recorded, { id: 100, startTime: recorded.startTime, execPath: recorded.execPath }), true)
  assert.equal(sameProcessIdentity(recorded, { ...recorded, pid: 101 }), false)
  assert.equal(sameProcessIdentity(recorded, { ...recorded, startTime: '2026-11-22T00:00:01Z' }), false)
  assert.equal(sameProcessIdentity(recorded, { ...recorded, execPath: 'C:\\Other\\cmd.exe' }), false)
  assert.equal(sameProcessIdentity(recorded, null), false)
  assert.equal(sameProcessIdentity({ pid: 100, startTime: '', execPath: recorded.execPath }, recorded), false)
})

test('是启动器的后代但路径与命令行都无法佐证安装目录 → 判定不归属', () => {
  const lookup = lookupOf([
    launcherRecord(),
    { pid: 300, parentPid: 100, execPath: 'C:\\Other\\java.exe', commandLine: 'java -version' },
  ])

  const result = isOwnedByLaunch({ listenerPid: 300, launcherPid: 100, esHome: HOME, lookup })
  assert.equal(result.owned, false)
  assert.equal(result.relation, 'descendant')
})
