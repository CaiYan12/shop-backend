#!/usr/bin/env node
/**
 * 术语检查：读 GLOSSARY.md 的 _Avoid_ 列表，扫 src / test / scripts，命中即失败。
 * 为什么需要：GLOSSARY 只是文档，没有强制力；Phase 2 里「分类」漂移进了代码与测试名，靠人工审查才发现。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_DIRS = ['src', 'test', 'scripts']
const EXTS = new Set(['.ts', '.mts', '.js', '.mjs'])

// 这些词不能简单做子串匹配，跳过并写明原因，避免假阳性把检查变成噪音。
const SKIP = new Map([
  ['规格', '是「规格维度 / 规格选项 / 规格组合」的子串'],
  ['售罄', '本身是 GLOSSARY 的正式词条（与「缺货」互为 _Avoid_）'],
  ['缺货', '本身是 GLOSSARY 的正式词条（与「售罄」互为 _Avoid_）'],
  ['价格', '「价格区间 / 价格升序 / 价格降序 / 价格跨度」是合法复合词'],
  ['参数', '「连接参数 / 函数参数」是通用编程含义，不是「规格维度」的同义词'],
])

const glossary = readFileSync(join(ROOT, 'GLOSSARY.md'), 'utf8')
const allowed = new Set()
const avoid = new Set()
for (const line of glossary.split(/\r?\n/)) {
  const a = line.match(/^\*\*(.+?)\*\*[:：]/)
  if (a) allowed.add(a[1].trim())
  const v = line.match(/^_Avoid_[:：]\s*(.+)$/)
  if (v) for (const t of v[1].split(/[、,，]/)) { const s = t.trim(); if (s) avoid.add(s) }
}

const targets = []
for (const t of avoid) {
  if (SKIP.has(t)) continue
  if (allowed.has(t)) continue
  let isSub = false
  for (const a of allowed) if (a.includes(t)) { isSub = true; break }
  if (isSub) continue
  targets.push(t)
}

const hits = []
function walk(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) { if (name !== 'node_modules') walk(p); continue }
    if (!EXTS.has(extname(name))) continue
    if (name === 'check-terms.mjs') continue // 本文件自身要列举这些词，扫描会自命中
    const lines = readFileSync(p, 'utf8').split(/\r?\n/)
    lines.forEach((text, i) => {
      for (const t of targets) if (text.includes(t)) hits.push({ file: p.slice(ROOT.length + 1), line: i + 1, term: t, text: text.trim().slice(0, 120) })
    })
  }
}
for (const d of SCAN_DIRS) walk(join(ROOT, d))

if (hits.length === 0) {
  console.log(`[check:terms] 通过（检查 ${targets.length} 个 _Avoid_ 词：${targets.join('、')}）`)
  process.exit(0)
}
console.error(`[check:terms] 失败：${hits.length} 处命中 GLOSSARY 的 _Avoid_ 词`)
for (const h of hits) console.error(`  ${h.file}:${h.line}  「${h.term}」  ${h.text}`)
console.error('改用 GLOSSARY.md 里的正式词条。')
process.exit(1)
