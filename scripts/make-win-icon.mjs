#!/usr/bin/env node
/**
 * Generate build/icon.ico for Windows from build/icon.png.
 * png-to-ico resizes into the standard Windows icon sizes.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.resolve(here, '..', 'build', 'icon.png')
const target = path.resolve(here, '..', 'build', 'icon.ico')

try {
  await fs.access(source)
  const buffer = await pngToIco(source)
  await fs.writeFile(target, buffer)
  console.log(`wrote ${target}`)
} catch (error) {
  console.error(`[icon:win] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
