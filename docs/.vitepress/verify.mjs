import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const output = new URL('./dist/', import.meta.url)
const report = 'examples/scenario.html'
const reportHref = `href="/TuiLens/${report}"`

// VitePress validates Markdown links, but the custom landing component links to built pages and a static report.
for (const locale of ['', 'zh-CN/']) {
  const home = await readFile(new URL(`${locale}index.html`, output), 'utf8')
  const guidePath = `${locale}GETTING-STARTED.html`
  const guide = await readFile(new URL(guidePath, output), 'utf8')
  for (const anchor of ['mcp', 'cli', 'sdk']) {
    assert.ok(home.includes(`href="/TuiLens/${guidePath}#${anchor}"`), `Home must link to ${guidePath}#${anchor}`)
    assert.ok(guide.includes(`id="${anchor}"`), `Missing anchor in ${guidePath}: ${anchor}`)
  }
  assert.ok(home.includes(reportHref), `Missing sample report link on ${locale}index.html`)
  assert.ok(guide.includes(reportHref), `Missing sample report link on ${guidePath}`)
}

const sample = await readFile(new URL(report, output), 'utf8')
assert.match(sample, /<title>TuiLens scenario evidence<\/title>/)
console.log('Verified both landing pages, their guide sections and the sample report.')
