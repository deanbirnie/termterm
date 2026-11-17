#!/usr/bin/env node
/**
 * Checks a release's files before they are published:
 *
 *   node check-release-files.mjs <folder> <version> [--apk]
 *
 * - every file a release should have is there (the APK only with --apk), and
 *   nothing unexpected;
 * - the updater's metadata (latest.yml for Windows, latest-linux.yml) names
 *   this version, and every file it lists exists with the size and SHA-512 it
 *   gives, so installed apps can download and verify the update.
 *
 * Prints what it checked; exits 1 listing every problem found.
 * Tested by check-release-files.test.mjs (node --test).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function expectedFiles(version, apk) {
  return [
    `termterm-${version}-setup.exe`,
    `termterm-${version}-setup.exe.blockmap`,
    `termterm-${version}-portable.exe`,
    `termterm-${version}-x86_64.AppImage`,
    'latest.yml',
    'latest-linux.yml',
    ...(apk ? [`termterm-${version}.apk`] : []),
  ]
}

/** The few fields of electron-builder's metadata the updater uses. */
export function parseUpdateYaml(text) {
  const out = { version: undefined, path: undefined, sha512: undefined, files: [] }
  let current = null
  for (const line of text.split(/\r?\n/)) {
    let m
    if ((m = /^version:\s*'?([^'\s]+)'?\s*$/.exec(line))) out.version = m[1]
    else if ((m = /^path:\s*(.+?)\s*$/.exec(line))) out.path = m[1]
    else if ((m = /^sha512:\s*(.+?)\s*$/.exec(line))) out.sha512 = m[1]
    else if ((m = /^\s+-\s+url:\s*(.+?)\s*$/.exec(line))) out.files.push((current = { url: m[1] }))
    else if (current && (m = /^\s+(sha512|size):\s*(.+?)\s*$/.exec(line))) current[m[1]] = m[2]
  }
  return out
}

const sha512 = (file) => createHash('sha512').update(readFileSync(file)).digest('base64')

export function checkReleaseFiles(dir, version, apk) {
  const problems = []
  const notes = []
  const present = existsSync(dir) ? readdirSync(dir) : []
  const expected = expectedFiles(version, apk)
  for (const name of expected) {
    if (!present.includes(name)) problems.push(`missing: ${name}`)
    else if (statSync(join(dir, name)).size === 0) problems.push(`empty: ${name}`)
  }
  for (const name of present) if (!expected.includes(name)) problems.push(`unexpected file: ${name}`)

  for (const meta of ['latest.yml', 'latest-linux.yml']) {
    if (!present.includes(meta)) continue
    const y = parseUpdateYaml(readFileSync(join(dir, meta), 'utf8'))
    if (y.version !== version) problems.push(`${meta} says version ${y.version}, not ${version}`)
    if (!y.files.length) problems.push(`${meta} lists no files`)
    for (const f of y.files) {
      const file = join(dir, f.url)
      if (!existsSync(file)) {
        problems.push(`${meta} lists ${f.url}, which is not in the release`)
        continue
      }
      if (String(statSync(file).size) !== f.size) problems.push(`${meta}: ${f.url} is ${statSync(file).size} bytes, not ${f.size}`)
      if (sha512(file) !== f.sha512) problems.push(`${meta}: ${f.url} does not match its SHA-512`)
      else notes.push(`${meta}: ${f.url} matches its size and SHA-512`)
    }
    if (y.path && !y.files.some((f) => f.url === y.path)) problems.push(`${meta}: path ${y.path} is not among its files`)
    if (y.sha512 && y.path && y.files.find((f) => f.url === y.path)?.sha512 !== y.sha512) {
      problems.push(`${meta}: the top-level sha512 disagrees with the file's`)
    }
  }
  return { problems, notes }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, version, flag] = process.argv.slice(2)
  if (!dir || !version) {
    console.error('usage: check-release-files.mjs <folder> <version> [--apk]')
    process.exit(2)
  }
  const { problems, notes } = checkReleaseFiles(dir, version, flag === '--apk')
  for (const n of notes) console.log(`ok: ${n}`)
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`)
    process.exit(1)
  }
  console.log(`All ${expectedFiles(version, flag === '--apk').length} release files for ${version} are present and consistent.`)
}
