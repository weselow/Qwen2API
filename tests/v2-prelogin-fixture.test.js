const test = require('node:test')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

test('v2 login opens the form, isolates cookies and stops before submitting a challenged form', () => {
  // Auth origins are captured at module load. Give the synthetic service its own runtime.
  execFileSync(process.execPath, [path.join(__dirname, 'fixtures', 'v2-prelogin-scenario.cjs')], {
    timeout: 15000, windowsHide: true
  })
})
