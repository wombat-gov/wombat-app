#!/usr/bin/env node
/**
 * Verify the shell i18n dictionary: en/de key parity, no duplicates.
 * Run with `npm run check:i18n`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.resolve(here, '..', 'src', 'i18n.js'), 'utf8')

const enStart = source.indexOf('  en: {')
const deStart = source.indexOf('  de: {')
if (enStart < 0 || deStart < 0 || deStart <= enStart) {
  console.error('[i18n] could not locate en/de blocks in src/i18n.js')
  process.exit(1)
}

const enBlock = source.slice(enStart, deStart)
const deBlock = source.slice(deStart)

function keys(block) {
  return [...block.matchAll(/^\s{4}'([^']+)':/gm)].map(match => match[1])
}

function duplicates(list) {
  const seen = new Set()
  const dupes = new Set()
  for (const key of list) {
    if (seen.has(key)) dupes.add(key)
    seen.add(key)
  }
  return [...dupes]
}

const en = keys(enBlock)
const de = keys(deBlock)
const enSet = new Set(en)
const deSet = new Set(de)
const missingDe = en.filter(key => !deSet.has(key))
const missingEn = de.filter(key => !enSet.has(key))
const dupesEn = duplicates(en)
const dupesDe = duplicates(de)

let failed = false
if (dupesEn.length) {
  console.error(`[i18n] duplicate en keys: ${dupesEn.join(', ')}`)
  failed = true
}
if (dupesDe.length) {
  console.error(`[i18n] duplicate de keys: ${dupesDe.join(', ')}`)
  failed = true
}
if (missingDe.length) {
  console.error(`[i18n] missing in de: ${missingDe.join(', ')}`)
  failed = true
}
if (missingEn.length) {
  console.error(`[i18n] missing in en: ${missingEn.join(', ')}`)
  failed = true
}

if (failed) process.exit(1)
console.log(`[i18n] ok — ${en.length} keys in en and de`)
