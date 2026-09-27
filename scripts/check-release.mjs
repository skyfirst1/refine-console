import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, resolve, relative, extname, isAbsolute } from 'node:path';

const root = process.cwd();
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))].filter(file => file && existsSync(file));
const problems = [];
const report = (file, reason) => problems.push(`${file}: ${reason}`);
const builtInSkills = new Set(['.pi/skills/refine-agent/SKILL.md', '.pi/skills/refine-workflow/SKILL.md', '.pi/skills/refine-harness-audit/SKILL.md', '.pi/skills/expert-replay-audit/SKILL.md', '.pi/skills/expert-replay-evaluation/SKILL.md']);
const textExtensions = new Set(['.ts', '.js', '.mjs', '.json', '.md', '.yaml', '.yml', '.ps1', '.py', '.example']);
// These literal strings exercise redaction; no blanket test-directory exemption.
const syntheticKeys = new Set(['sk-proj-1234567890abcdef', 'sk-abcdefghijklmnop', 'sk-test-12345678901234567890', 'sk-ac-private-token', 'sk-ac-prefixed-token', 'sk-ac-1234567890abcdef']);
const secretPatterns = [
  /\bsk-(?:proj-|ac-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

for (const file of files) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) { report(file, 'symlink is not a portable release file'); continue; }
  if (!stat.isFile()) { report(file, 'not a regular file'); continue; }
  if (/^(?:validation|\.refine-console|node_modules|artifacts|runs|releases|\.local)\//.test(file)
      || (file.startsWith('.pi/') && !builtInSkills.has(file))
      || /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials\.json)$/.test(file) && !file.endsWith('.env.example')
      || /\.(?:pem|key|p12|pfx|log|jsonl)$/.test(file)
      || /^sidecar\/(?:data|acontext_data)\//.test(file)) report(file, 'private or generated data in release tree');
  if (stat.size > 10 * 1024 * 1024) report(file, 'file exceeds 10 MiB; review before publishing');
  if (!textExtensions.has(extname(file))) continue;
  const text = readFileSync(file, 'utf8');
  if (/[A-Z]:[\\/]+Users[\\/]+(?!Public\b|example\b)[^\s"'<>]+/i.test(text)
      || /D:[\\/]+harness[\\/]/i.test(text)) report(file, 'developer-machine path must be removed or parameterized');
  for (const pattern of secretPatterns) for (const match of text.matchAll(pattern)) {
    if ((file.startsWith('test/') || file === 'scripts/check-release.mjs') && syntheticKeys.has(match[0])) continue;
    report(file, `possible secret at line ${text.slice(0, match.index).split('\n').length} (value withheld)`);
  }
  if (file.endsWith('.md')) {
    const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
    for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      const href = match[1].replace(/^<|>$/g, '').split(/\s+"/)[0];
      if (/^(?:https?:|mailto:|#)/.test(href)) continue;
      const path = decodeURIComponent(href.split('#')[0]);
      if (!path) continue;
      const target = resolve(dirname(file), path), rel = relative(root, target);
      if (isAbsolute(rel) || rel.startsWith('..') || !existsSync(target)) report(file, `missing or external local link: ${href}`);
    }
  }
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
if (pkg.name !== lock.name || pkg.name !== lock.packages[''].name) report('package-lock.json', 'package name mismatch');
for (const [name, command] of Object.entries(pkg.scripts)) {
  for (const match of command.matchAll(/\bscripts\/[\w.-]+\.(?:ts|mjs|js|py|ps1)\b/g)) if (!existsSync(match[0])) report('package.json', `${name} references missing ${match[0]}`);
}
for (const file of builtInSkills) if (!files.includes(file)) report(file, 'required bundled Skill missing');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else console.log(`Release preflight passed: ${files.length} files; common-secret and path checks only, not a security guarantee.`);
