#!/usr/bin/env node
// Checks that the skill is ready to run: Node version, Playwright and its browser, Wappalyzer, and
// whether the optional DataForSEO credentials are set (never their values).
//
// Usage: node scripts/check.mjs    (exits 0 when ready, 1 when setup is needed)

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib.mjs';
import { seoCredentials } from './seo.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ready = true;
const report = (ok, label, detail) => { if (!ok) ready = false; console.log(`${ok ? 'ok     ' : 'MISSING'}  ${label}${detail ? `: ${detail}` : ''}`); };

const major = Number(process.versions.node.split('.')[0]);
report(major >= 20, 'Node.js 20 or later', `this is ${process.version}`);

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch {}
report(!!chromium, 'Playwright', chromium ? '' : 'not installed');

if (chromium) {
  // Starting the browser is the only sure test: the files can be there for another Playwright version.
  let error = null;
  try { await (await chromium.launch()).close(); } catch (e) { error = /Executable doesn't exist/.test(e.message) ? 'not downloaded, or removed by an update' : e.message.split('\n')[0]; }
  report(!error, 'Chromium browser', error || '');
}

const wappalyzer = existsSync(path.join(SKILL_DIR, 'vendor/wappalyzer/cli.js'));
console.log(`${wappalyzer ? 'ok     ' : 'note   '}  Wappalyzer${wappalyzer ? '' : ': not installed. Runs still work from the network capture; setup installs it.'}`);

const env = await loadEnv(SKILL_DIR);
console.log(`${seoCredentials(env) ? 'ok     ' : 'note   '}  Search data (optional): DataForSEO credentials ${seoCredentials(env) ? 'found' : 'not set'}`);

if (!ready) console.log(`\nSetup needed: sh ${path.join(SKILL_DIR, 'scripts/setup.sh')}`);
process.exit(ready ? 0 : 1);
