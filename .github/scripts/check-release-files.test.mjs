// node --test .github/scripts/check-release-files.test.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkReleaseFiles, expectedFiles, parseUpdateYaml } from './check-release-files.mjs'

const V = '1.2.3'
const hash = (s) => createHash('sha512').update(s).digest('base64')

/** A release folder as the publish job sees it, built from the real 0.9.0 metadata layout. */
function release({ apk = true, tamper } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-'))
  const contents = Object.fromEntries(expectedFiles(V, apk).filter((n) => !n.endsWith('.yml')).map((n) => [n, `contents of ${n}`]))
  for (const [n, c] of Object.entries(contents)) writeFileSync(join(dir, n), c)
  const meta = (file) => {
    const c = contents[file]
    return `version: ${V}\nfiles:\n  - url: ${file}\n    sha512: ${hash(c)}\n    size: ${Buffer.byteLength(c)}\npath: ${file}\nsha512: ${hash(c)}\nreleaseDate: '2026-11-17T14:27:05.000Z'\n`
  }
  writeFileSync(join(dir, 'latest.yml'), meta(`termterm-${V}-setup.exe`))
  writeFileSync(join(dir, 'latest-linux.yml'), meta(`termterm-${V}-x86_64.AppImage`))
  tamper?.(dir)
  return dir
}

test('a complete release passes', () => {
  const dir = release()
  try {
    const { problems, notes } = checkReleaseFiles(dir, V, true)
    assert.deepEqual(problems, [])
    assert.equal(notes.length, 2)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('the APK is only required when asked for', () => {
  const dir = release({ apk: false })
  try {
    assert.deepEqual(checkReleaseFiles(dir, V, false).problems, [])
    assert.deepEqual(checkReleaseFiles(dir, V, true).problems, [`missing: termterm-${V}.apk`])
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('missing, empty, unexpected and altered files are all reported', () => {
  const dir = release({
    tamper: (d) => {
      rmSync(join(d, `termterm-${V}-portable.exe`))
      writeFileSync(join(d, `termterm-${V}-setup.exe.blockmap`), '')
      writeFileSync(join(d, 'stray.txt'), 'x')
      writeFileSync(join(d, `termterm-${V}-x86_64.AppImage`), 'something else')
    },
  })
  try {
    const { problems } = checkReleaseFiles(dir, V, true)
    assert.ok(problems.includes(`missing: termterm-${V}-portable.exe`))
    assert.ok(problems.includes(`empty: termterm-${V}-setup.exe.blockmap`))
    assert.ok(problems.includes('unexpected file: stray.txt'))
    assert.ok(problems.some((p) => p.includes('latest-linux.yml') && p.includes('SHA-512')))
    assert.ok(problems.some((p) => p.includes('latest-linux.yml') && p.includes('bytes')))
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('metadata for another version is caught', () => {
  const dir = release()
  try {
    assert.ok(checkReleaseFiles(dir, '1.2.4', true).problems.some((p) => p.includes('latest.yml says version 1.2.3, not 1.2.4')))
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('parses electron-builder metadata, quoted version included', () => {
  const y = parseUpdateYaml("version: '0.9.0'\nfiles:\n  - url: a.exe\n    sha512: abc==\n    size: 12\npath: a.exe\nsha512: abc==\n")
  assert.deepEqual(y, { version: '0.9.0', path: 'a.exe', sha512: 'abc==', files: [{ url: 'a.exe', sha512: 'abc==', size: '12' }] })
})
