#!/usr/bin/env bash
set -euo pipefail

checker=$(cd "$(dirname "$0")" && pwd)/no-new-comments.sh
name=$(sed -n "s/^names='\([a-z]*\) .*/\1/p" "$checker")
[[ -n $name ]] || { echo "can't read the names the checker looks for" >&2; exit 1; }
repo=$(mktemp -d) || exit 1
trap 'rm -rf -- "${repo:?}"' EXIT
cd "$repo"
git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
git config commit.gpgsign false

failed=0
put() { mkdir -p "$(dirname "$1")"; cat >"$1"; }
commit() { git add -A && git commit -q --allow-empty -m "$1"; }

mkdir -p src
put src/old.js <<'EOF'
export function total(items) {
  // Sum the prices, skipping the free ones because the cart shows them apart.
  return items.filter((i) => i.price > 0).reduce((a, i) => a + i.price, 0);
}
EOF
put src/keep.py <<'EOF'
def run():
    return 1  # keep this one
EOF
put src/conf.js <<'EOF'
export const fallback = load();
EOF
put docs/guide.md <<'EOF'
Prices skip the free items.
EOF
commit base

expect() {
  local want=$1 label=$2 out code=0
  shift 2
  out=$(bash "$checker" --base main --head HEAD "$@" 2>&1) || code=$?
  if [[ $want == pass && $code -ne 0 ]] || [[ $want != pass && $code -ne 1 ]] || [[ $want != pass && $out != *"$want"* ]]; then
    echo "FAIL: $label (exit $code)"
    printf '%s\n' "$out" | sed 's/^/    /'
    failed=1
  else
    echo "ok: $label"
  fi
}

case_branch() { git checkout -q main && git checkout -q -B "case-$1"; }

case_branch js
put src/a.js <<'EOF'
export const a = 1;
// Loops over the cards so the header stays in sync.
export const b = 2;
EOF
commit "feat: add a"
expect "src/a.js:2: adds a comment" "a new JS line comment fails"

case_branch tsblock
put src/a.ts <<'EOF'
/* Keeps the header in sync. */
export const a: number = 1;
const b = {
  c: 2,
  /**
   * The width of the card.
   */
  w: 3,
};
EOF
commit "feat: add a"
expect "src/a.ts:6: adds a comment" "a new TS block comment fails"

case_branch markup
mkdir -p web
printf '%s\n' 'export const FRAG = /* glsl */ `' '  float a = 1.0;' '  // the glow fades out here' '  vec2 b = vec2(a, a / 2.0);' '`;' >web/shader.ts
put web/a.css <<'EOF'
.a { color: red; } /* the brand red */
EOF
put web/a.html <<'EOF'
<div>
  <!-- the header -->
  <script>
    const u = "https://example.com";
    // runs first
  </script>
</div>
EOF
commit "feat: add markup"
expect "web/shader.ts:3: adds a comment" "a comment in shader code inside a template fails"
expect "web/a.css:1: adds a comment" "a new CSS comment fails"
expect "web/a.html:2: adds a comment" "a new HTML comment fails"
expect "web/a.html:5: adds a comment" "a comment in an HTML script fails"

case_branch python
put tool/a.py <<'EOF'
def f():
    """Return one."""
    return 1


class G:
    '''
    A thing.
    '''
    x = 1  # the x
EOF
commit "feat: add python"
expect "tool/a.py:2: adds a docstring" "a new Python docstring fails"
expect "tool/a.py:8: adds a docstring" "a new multi-line Python docstring fails"
expect "tool/a.py:10: adds a comment" "a new Python comment fails"

case_branch shell
put tool/a.sh <<'EOF'
#!/usr/bin/env bash
x=1
echo "$x" # print it
tr a b <<< "hello"
echo $((1<<2))
cat <<'RUN' | bash
# then the disk
RUN
# after the here-string
ssh box sh <<'REMOTE'
uptime
# then the disk
df -h
REMOTE
EOF
put .github/workflows/a.yml <<'EOF'
on: push
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - run: |
          echo hi
          # say hi
EOF
put tool/a.toml <<'EOF'
a = 1 # one
EOF
commit "feat: add shell"
expect "tool/a.sh:3: adds a comment" "a new shell comment fails"
expect "tool/a.sh:12: adds a comment" "a comment in a script inside a heredoc fails"
expect "tool/a.sh:7: adds a comment" "a heredoc piped into a shell is read as a script"
expect "tool/a.sh:9: adds a comment" "a here-string or a shift doesn't hide later comments"
expect ".github/workflows/a.yml:8: adds a comment" "a new comment in a workflow step fails"
expect "tool/a.toml:1: adds a comment" "a new TOML comment fails"

case_branch powershell
put tool/a.ps1 <<'EOF'
<#
.SYNOPSIS
Does a thing.
#>
$x = 1 # the x
EOF
put tool/a.bat <<'EOF'
@echo off
REM start it
EOF
commit "feat: add powershell"
expect "tool/a.ps1:3: adds a comment" "a new PowerShell help block fails"
expect "tool/a.ps1:5: adds a comment" "a new PowerShell comment fails"
expect "tool/a.bat:2: adds a comment" "a new batch comment fails"

case_branch jvm
put mod/A.java <<'EOF'
class A {
    // the field
    int a = 1;
}
EOF
put mod/build.gradle <<'EOF'
plugins { id 'java' } // java
EOF
put app/A.cs <<'EOF'
class A {
    /// <summary>The field.</summary>
    int a = 1;
}
EOF
put db/a.sql <<'EOF'
select 1; -- one
EOF
commit "feat: add jvm"
expect "mod/A.java:2: adds a comment" "a new Java comment fails"
expect "mod/build.gradle:1: adds a comment" "a new Gradle comment fails"
expect "app/A.cs:2: adds a comment" "a new C# doc comment fails"
expect "db/a.sql:1: adds a comment" "a new SQL comment fails"

case_branch credit
put src/b.js <<'EOF'
export const b = 1;
EOF
commit "feat: add b" && git commit -q --amend -m "feat: add b" -m "Co-authored-by: Helper <noreply@example.com>"
expect "credits an assistant, model or bot as co-author" "a co-author trailer naming a bot fails"
git commit -q --amend -m "feat: add b with $name"
expect "names an assistant or model ($name)" "a commit message naming a model fails"
git commit -q --amend -m "feat: add b" -m "Generated with Copilot"
expect "carries an authorship label" "a generated-with line naming a coding tool fails"
git commit -q --amend -m "fix: convert the disk to GPT"
expect pass "a GPT partition table is not a model name"
git commit -q --amend -m "feat: add b"
expect "PR title: names an assistant or model" "a PR title naming a model fails" --title "Add b with ${name^}"
printf '%s\n' 'Adds b.' '' 'AI-generated summary.' >"$repo/.git/body"
expect "PR body line 3: carries an authorship label" "a PR body with an authorship label fails" --body-file "$repo/.git/body"
printf '%s\n' 'Adds b.' '' '<!-- This is an auto-generated comment: release notes by bot -->' '<!-- bot-ai-generated:v1 -->' 'Summary' '<!-- end of auto-generated comment: release notes by bot -->' >"$repo/.git/body"
expect pass "a review bot's own summary block in the PR body passes" --body-file "$repo/.git/body"
printf 'export const who = "%s";\n' "$name" >src/c.js
commit "feat: add c"
expect "src/c.js:1: names an assistant or model ($name)" "code naming a model fails"

case_branch reused
put src/conf.js <<'EOF'
export const fallback = loadAgain();
// fallback
EOF
git rm -q docs/guide.md
put src/price.js <<'EOF'
// Prices skip the free items.
export const price = 1;
EOF
commit "feat: reuse words"
expect "src/conf.js:2: adds a comment" "a comment repeating removed code fails"
expect "src/price.js:1: adds a comment" "a removed doc sentence turned into a comment fails"

case_branch lookalikes
put src/look.js <<'EOF'
// SPDX-License-Identifier: MIT
// Fetches the user list
// global state lives here
// eslint complains here because the cache is shared
/*! Explains why the cache is shared across tabs. */
// vim: this is a vim workaround
// 42
export const a = 1;
// Shows the copyright year in the footer.
export const b = <p><b>a</b>{/* note */}</p>;
EOF
put tool/look.ps1 <<'EOF'
# requires the network
$a = 1
EOF
put "src/my file.js" <<'EOF'
// in a spaced path
export const c = 1;
EOF
put .github/workflows/script.yml <<'EOF'
on: push
jobs:
  s:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            // ask the API
            await github.rest.repos.get(context.repo);
EOF
commit "feat: add lookalikes"
expect "src/look.js:2: adds a comment" "an explanation under a license line fails"
expect "src/look.js:3: adds a comment" "plain words that start like a directive fail"
expect "src/look.js:4: adds a comment" "plain words that start with a linter name fail"
expect "src/look.js:5: adds a comment" "a preserved comment below the header fails"
expect "src/look.js:6: adds a comment" "plain words after an editor name fail"
expect "src/look.js:7: adds a comment" "a bare number fails"
expect "src/look.js:9: adds a comment" "a comment that mentions copyright fails"
expect "src/look.js:10: adds a comment" "a JSX comment after a closing tag fails"
expect "tool/look.ps1:1: adds a comment" "plain words after # requires fail"
expect "src/my file.js:1: adds a comment" "a comment in a path with a space fails"
expect ".github/workflows/script.yml:9: adds a comment" "a comment in a workflow script block fails"

case_branch moved
git rm -q src/old.js
put src/new.js <<'EOF'
export function total(items) {
  return items
    // Sum the prices, skipping the free ones
    // because the cart shows them apart.
    .filter((i) => i.price > 0)
    .reduce((a, i) => a + i.price, 0);
}
EOF
put src/keep.py <<'EOF'
def run():
    return 2  # keep this one
EOF
commit "refactor: move total"
expect pass "a moved, re-wrapped comment and a kept trailing comment pass"

case_branch allowed
put src/lic.js <<'EOF'
/*
 * Copyright (c) 2026 Example
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy.
 */
// SPDX-License-Identifier: MIT
// @ts-check
/* global window, document */
/* eslint-disable no-console */
// eslint-disable-next-line no-unused-vars
const re = /\/\/ not a comment/g;
const url = "https://example.com/#top";
const t = `a // b ${"/* c */"} d https://*.example.com`;
// prettier-ignore
const m = [1,0,
           0,1];
const lazy = () => import(/* @vite-ignore */ url);
const Link = () => <p>See https://example.com for more</p>;
export { re, t, m, lazy, Link };
EOF
put src/d.ts <<'EOF'
// @ts-expect-error the old type is wrong
export const d: string = 1;
EOF
put web/b.scss <<'EOF'
.a { background: url(https://example.com/a.png); }
EOF
put tool/b.sh <<'EOF'
#!/usr/bin/env bash
# shellcheck disable=SC2034
n=${#BASH_ARGV[@]} c=$# s="a # b" u='# c'
cat <<'TXT'
#!/bin/sh
a # b
TXT
cat >>"$GITHUB_STEP_SUMMARY" <<TXT
# Results
## Passed
TXT
EOF
put tool/b.py <<'EOF'
import os  # noqa: F401
x: int = "1"  # type: ignore
s = "# not a comment"
y = (
    """not a docstring"""
)
EOF
put tool/b.ps1 <<'EOF'
#Requires -Version 5.1
#region Setup
$s = @"
a # inside a here-string
"@
$t = 'a # b'
#endregion
EOF
put Dockerfile <<'EOF'
# syntax=docker/dockerfile:1
FROM alpine
EOF
put .github/workflows/b.yml <<'EOF'
on: push
jobs:
  b:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: echo "${#GITHUB_SHA} # not a comment"
EOF
put docs/notes.md <<'EOF'
<!-- docs are prose, not code -->
# Notes
EOF
commit "feat: add allowed"
expect pass "license headers, shebangs, directives, strings and docs pass"

[[ $failed -eq 0 ]] && echo "All cases behaved." || exit 1
