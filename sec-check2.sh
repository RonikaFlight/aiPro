#!/bin/bash
set -e
cd /home/z/my-project

echo '=== CHECK 7b: Server-side fetch to external URLs ==='
rg -n 'fetch\(.*https?:' src/ -g '*.ts' -g '*.tsx' 2>/dev/null | head -30

echo ''
echo '=== CHECK 7c: Fetch in lib/ (server-side) ==='
rg -n 'fetch\(.*(url|target|href|uri)' src/lib/ -g '*.ts' 2>/dev/null | head -20

echo ''
echo '=== CHECK 7d: All server-side fetch calls ==='
rg -n 'await fetch\(\`http' src/lib/ -g '*.ts' 2>/dev/null | head -20
rg -n 'await fetch\(\`http' src/app/api/ -g '*.ts' 2>/dev/null | head -20

echo ''
echo '=== CHECK 4b: Check if problem type URIs use env ==='
rg -n 'PROBLEM_TYPE_BASE|problems/' src/lib/errors.ts 2>/dev/null | head -10

echo ''
echo '=== CHECK 4c: Check env.ts for APP_URL ==='
rg -n 'APP_URL' src/lib/env.ts 2>/dev/null | head -5
