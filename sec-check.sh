#!/bin/bash
set -e
cd /home/z/my-project

echo '========================================'
echo 'CHECK 3: Placeholder secret keys'
echo '========================================'
rg -in 'changeme|your-secret-here|replace-me' src/ -g '*.ts' -g '*.tsx' 2>/dev/null || echo '(none found)'

echo ''
echo '========================================'
echo 'CHECK 3b: TODO/FIXME in src (not tests, not md)'
echo '========================================'
rg -n 'TODO|FIXME' src/ -g '*.ts' -g '*.tsx' 2>/dev/null | rg -v '__tests__|node_modules' | head -30

echo ''
echo '========================================'
echo 'CHECK 4: Hard-coded production URLs'
echo '========================================'
rg -n 'proofpilot\.app' src/ -g '*.ts' -g '*.tsx' 2>/dev/null | rg -v 'env\.ts|\.env' | head -20

echo ''
echo '========================================'
echo 'CHECK 5: Raw SQL with string concatenation'
echo '========================================'
rg -n 'queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe' src/ -g '*.ts' 2>/dev/null | head -20

echo ''
echo '========================================'
echo 'CHECK 6: eval/exec/Function from user input'
echo '========================================'
rg -n '\beval\(|exec\(|execSync\(|new Function\(|Function\(' src/ -g '*.ts' -g '*.tsx' 2>/dev/null | head -20

echo ''
echo '========================================'
echo 'CHECK 7: Unrestricted fetch calls'
echo '========================================'
rg -n 'fetch\(' src/ -g '*.ts' -g '*.tsx' 2>/dev/null | rg -v 'safe-url|ssrf-guard|next/server|node-fetch|__tests__|\.d\.ts' | head -40
