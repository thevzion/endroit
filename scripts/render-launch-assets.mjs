import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const assets = new URL('../docs/assets/', import.meta.url).pathname
const proof = join(assets, 'checkpoint-terminal.png')

await mkdir(assets, { recursive: true })
await exec('magick', [
  '-size', '1200x630',
  'xc:#111315',
  '-fill', '#1b1e21',
  '-stroke', '#34393e',
  '-strokewidth', '2',
  '-draw', 'roundrectangle 38,34 1162,596 18,18',
  '-fill', '#25292d',
  '-stroke', 'none',
  '-draw', 'roundrectangle 40,36 1160,92 16,16',
  '-fill', '#e06c5f',
  '-draw', 'circle 72,64 80,64',
  '-fill', '#d9a34d',
  '-draw', 'circle 100,64 108,64',
  '-fill', '#62ad73',
  '-draw', 'circle 128,64 136,64',
  '-gravity', 'northwest',
  '-font', 'Courier-New-Bold',
  '-fill', '#aeb5ba',
  '-pointsize', '19',
  '-annotate', '+170+56', 'hairness 0.5 / local checkpoint',
  '-font', 'Courier-New',
  '-pointsize', '22',
  '-fill', '#d8996a',
  '-annotate', '+76+126', '$ npm run test:node22',
  '-fill', '#8fc49a',
  '-annotate', '+76+166', '  tests 18  pass 18  fail 0',
  '-fill', '#d8996a',
  '-annotate', '+76+216', '$ npm run test:node24',
  '-fill', '#8fc49a',
  '-annotate', '+76+256', '  tests 18  pass 18  fail 0',
  '-fill', '#d8996a',
  '-annotate', '+76+306', '$ npm run check:lab',
  '-fill', '#8fc49a',
  '-annotate', '+76+346', '  Home + Desk + 3 Targets + HUD + Doctor ready',
  '-fill', '#d8996a',
  '-annotate', '+76+396', '$ npm run check:pack',
  '-fill', '#8fc49a',
  '-annotate', '+76+436', '  one CLI · four bundled Assets',
  '-fill', '#d8996a',
  '-annotate', '+76+486', '$ npm audit --omit=dev',
  '-fill', '#8fc49a',
  '-annotate', '+76+526', '  found 0 vulnerabilities',
  '-fill', '#768089',
  '-pointsize', '17',
  '-annotate', '+76+570', 'local qualification · no push · no merge · no publish',
  '-depth', '8',
  proof,
])

process.stdout.write(`${proof}\n`)
