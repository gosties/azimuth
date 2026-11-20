import { readFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
for (const file of ['provenance.json', 'json.provenance.json']) {
  const manifest = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'))
  const binary = readFileSync(new URL(manifest.filename, import.meta.url))
  if (binary.length !== manifest.bytes || createHash('sha256').update(binary).digest('hex') !== manifest.sha256) {
    throw new Error('Bundled DuckDB extension failed its pinned integrity check: ' + manifest.name)
  }
}
const runtime = JSON.parse(readFileSync(new URL('runtime.provenance.json', import.meta.url), 'utf8'))
const packageRoot = new URL('../../../node_modules/@duckdb/duckdb-wasm/', import.meta.url)
const packageVersion = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')).version
if (packageVersion !== runtime.duckdb_wasm_npm_version) throw new Error('DuckDB runtime package version does not match its provenance.')
for (const extension of ['provenance.json', 'json.provenance.json']) {
  const metadata = JSON.parse(readFileSync(new URL(extension, import.meta.url), 'utf8'))
  if (metadata.duckdb_version !== runtime.duckdb_version || metadata.duckdb_wasm_npm_version !== packageVersion || metadata.platform !== runtime.platform) throw new Error('DuckDB extension ABI does not match the pinned runtime.')
}
for (const file of runtime.files) {
  const binary = readFileSync(new URL('dist/' + file.filename, packageRoot))
  if (binary.length !== file.bytes || createHash('sha256').update(binary).digest('hex') !== file.sha256) throw new Error('Bundled DuckDB runtime failed its pinned integrity check: ' + file.filename)
}
console.log('Bundled DuckDB extension integrity verified.')
if (process.argv.includes('--emit-notices')) {
  const destination = new URL('../../../dist/licenses/', import.meta.url)
  mkdirSync(destination, { recursive: true })
  copyFileSync(new URL('./LICENSE.duckdb', import.meta.url), new URL('duckdb-parquet.LICENSE.txt', destination))
  copyFileSync(new URL('./provenance.json', import.meta.url), new URL('duckdb-parquet.provenance.json', destination))
  copyFileSync(new URL('./json.provenance.json', import.meta.url), new URL('duckdb-json.provenance.json', destination))
  copyFileSync(new URL('./runtime.provenance.json', import.meta.url), new URL('duckdb-runtime.provenance.json', destination))
  const gdal = new URL('../../../node_modules/gdal3.js/', import.meta.url)
  copyFileSync(new URL('LICENSE', gdal), new URL('gdal3.js.LICENSE.txt', destination))
  copyFileSync(new URL('./gdal3.provenance.json', import.meta.url), new URL('gdal3.js.provenance.json', destination))
  const { writeFileSync } = await import('node:fs')
  const readme = readFileSync(new URL('README.md', gdal), 'utf8')
  const notice = readme.slice(readme.indexOf('## License'), readme.indexOf('**Inspired by**'))
  writeFileSync(new URL('gdal3.js.NOTICES.md', destination), notice)
  for (const [packagePath, filename, license] of [
    ['@tmcw/togeojson', 'togeojson', 'LICENSE'],
    ['@xmldom/xmldom', 'xmldom', 'LICENSE'],
  ]) {
    copyFileSync(new URL('../../../node_modules/' + packagePath + '/' + license, import.meta.url), new URL(filename + '.LICENSE.txt', destination))
  }
}
