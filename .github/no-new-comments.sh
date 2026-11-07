#!/usr/bin/env bash
set -euo pipefail

names='codex fable claude astra chatgpt openai anthropic lifeos gpt-?[0-9][a-z0-9.]* gemini opus'
coauthor_names='gpt copilot cursor devin aider'

exceptions=(
  '.github/no-new-comments.sh|*|the checker holds the names it looks for'
  '.github/no-new-comments-e2e.sh|*|its fixtures hold the patterns on purpose'
  '.gitignore|*|ignore rules name tool folders'
  '*/.gitignore|*|ignore rules name tool folders'
  'package-lock.json|*|lockfiles list dependency names as published'
  '*/package-lock.json|*|lockfiles list dependency names as published'
  'server/cowrite/*|codex|the co-writer runs on a hosted writing service by that name'
  'server/cowrite/*|openai|the co-writer signs in to that service'
  'server/cowrite/*|chatgpt|the co-writer signs in to that service'
  'server/e2e/cowrite.mjs|*|the co-writer scenarios drive that service'
  'scripts/cowriter-setup.sh|*|the co-writer setup installs that service'
  'smp/*|astra|Ad Astra is a mod in the pack'
  'smp/*|opus|the voice chat mod uses the Opus codec'
  'backend/catalogs/*|*|the app catalogs list installed apps by their real names'
  'tools/catalogs/*|*|the app catalogs list installed apps by their real names'
  'docs/internal/frontend/*/Assets/Tweaks/*|*|the app catalogs list installed apps by their real names'
  'scripts/capture-landing-run.mjs|*|the browser runner starts a local desktop tool by that name'
  'scripts/design-e2e-run.mjs|*|the browser runner starts a local desktop tool by that name'
  'scripts/keyring-e2e-run.mjs|*|the browser runner starts a local desktop tool by that name'
  'scripts/past-events-e2e.mjs|*|the browser runner starts a local desktop tool by that name'
  '.agents/*|*|repo skills name the command line tools they run under'
  'scripts/diagnose-repo-skill-harnesses.sh|*|repo skills name the command line tools they run under'
  'tests/repo-skills-e2e.sh|*|repo skills name the command line tools they run under'
  'tools/validation/check_agent_files.py|*|the check that keeps tool instruction files out names them'
)

comment_exceptions=(
  '.github/no-new-comments-e2e.sh|its fixtures hold comments on purpose'
)

usage() {
  echo "usage: $0 [--base REF] [--head REF] [--title TEXT] [--body-file FILE]" >&2
  exit 2
}

base=${BASE_SHA:-}
head=${HEAD_SHA:-HEAD}
title=${PR_TITLE-}
body=${PR_BODY-}
while (($#)); do
  case $1 in
    --base) (($# > 1)) || usage; base=$2; shift 2 ;;
    --head) (($# > 1)) || usage; head=$2; shift 2 ;;
    --title) (($# > 1)) || usage; title=$2; shift 2 ;;
    --body-file) (($# > 1)) || usage; body=$(cat -- "$2"); shift 2 ;;
    *) usage ;;
  esac
done
if [[ -z $base ]]; then
  base=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null) || base=origin/main
fi
mb=$(git merge-base "$base" "$head") || { echo "Can't find where $head branched off $base." >&2; exit 2; }

work=$(mktemp -d) || exit 1
trap 'rm -rf -- "${work:?}"' EXIT

git -c core.quotePath=false diff --no-color --no-ext-diff -M -U0 --src-prefix=a/ --dst-prefix=b/ \
  "$mb" "$head" >"$work/diff"

awk -v added="$work/added" -v removed="$work/removed" '
/^diff --git / { hdr = 1; path = ""; opath = ""; next }
hdr && /^--- / { opath = substr($0, 7); sub(/\t$/, "", opath); if ($0 == "--- /dev/null") opath = ""; next }
hdr && /^\+\+\+ / { path = substr($0, 7); sub(/\t$/, "", path); if ($0 == "+++ /dev/null") path = ""; next }
/^@@ / {
  hdr = 0; split($0, h, " ")
  sub(/^-/, "", h[2]); split(h[2], o, ","); oln = o[1] + 0
  sub(/^\+/, "", h[3]); split(h[3], c, ","); ln = c[1] + 0
  next
}
hdr { next }
/^\+/ { if (path != "") printf "%s\t%d\t%s\n", path, ln, substr($0, 2) > added; ln++; next }
/^-/ { if (opath != "") printf "%s\t%d\n", opath, oln > removed; oln++ }
' "$work/diff"
touch "$work/added" "$work/removed"

lang_of() {
  local p=${1,,} b=${1##*/} ref=${2:-$head}
  b=${b,,}
  case $p in
    *.js | *.mjs | *.cjs | *.jsx | *.ts | *.tsx | *.mts | *.cts) echo js ;;
    *.java | *.kt | *.kts | *.gradle | *.groovy | *.cs | *.c | *.h | *.cc | *.cpp | *.hpp | *.go | *.rs | *.swift | *.scala | *.dart | *.scss | *.less | *.jsonc | *.json5) echo c ;;
    *.css) echo css ;;
    *.html | *.htm | *.xml | *.svg | *.xaml | *.csproj | *.props | *.targets | *.resx | *.manifest | *.config | *.plist | *.vue | *.svelte) echo markup ;;
    *.py | *.pyi | *.pyw) echo py ;;
    *.sh | *.bash | *.zsh | *.bats | *.ksh) echo sh ;;
    *.ps1 | *.psm1 | *.psd1) echo ps ;;
    *.sql) echo sql ;;
    *.yml | *.yaml | *.toml) echo yaml ;;
    *.bat | *.cmd) echo bat ;;
    *.iss) echo iss ;;
    *)
      case $b in
        dockerfile | *.dockerfile | containerfile | makefile | *.mk | .gitignore | .gitattributes | .dockerignore | .npmrc | .editorconfig | .prettierignore | .eslintignore | .vercelignore | .env | .env.* | *.env | *.properties | *.service | *.timer | *.socket | *.conf | *.cfg | *.ini | *.example) echo line ;;
        *.*) ;;
        *)
          case $(git cat-file -p "$ref:$1" 2>/dev/null | head -c 200 | head -n 1) in
            '#!'*python*) echo py ;;
            '#!'*node* | '#!'*deno* | '#!'*bun*) echo js ;;
            '#!'*sh*) echo sh ;;
          esac
          ;;
      esac
      ;;
  esac
}

lex() {
  awk -v lang="$1" '
function out(ln, s, k) { if (k == "x") return; seen[ln] = 1; txt[ln] = txt[ln] s; if (k == "d") kind[ln] = "d"; if (ln > last) last = ln }
function open_str(q, e, t) { st = "str"; sq = q; sesc = e; sterm = t }
function stmt_start(pre) { sub(/[rRbBuUfF]+$/, "", pre); return pre ~ /^[ \t]*$/ && depth == 0 && !cont }
BEGIN { st = "code"; f = lang; yb = 0; depth = 0; cont = 0; tsp = 0; bd = 0; lastsig = ""; fc = 0 }
{
  line = $0; sub(/\r$/, "", line); n = length(line); i = 1
  if (NR == 1 && substr(line, 1, 2) == "#!") next
  if (lang == "yaml") {
    f = "yaml"
    if (yb) {
      ind = match(line, /[^ ]/) ? RSTART - 1 : -1
      if (ind == -1 || ind > ybind) { if (yblang == "") next; f = yblang }
      else { yb = 0; st = "code" }
    }
  }
  if (st == "here") {
    t = line; if (hstrip || lang == "yaml") sub(/^[ \t]+/, "", t)
    if (t == hterm) st = "code"
    else if (hscript && line ~ /^[ \t]*(#+|\/\/)([ \t]|$)/) out(NR, line, "c")
    next
  }
  if (st == "psh") {
    if (substr(line, 1, 2) == hterm) { st = "code"; i = 3 }
    else next
  }
  if (lang == "line") {
    if (line ~ /^[ \t]*[#;]/) out(NR, line, "c")
    next
  }
  if (lang == "bat") {
    t = tolower(line)
    if (t ~ /^[ \t]*@?(rem([ \t]|$)|::)/) out(NR, line, "c")
    next
  }
  if (lang == "iss") {
    if (line ~ /^[ \t]*(;|\/\/)/) out(NR, line, "c")
    next
  }
  if (st == "lc") st = "code"
  if (st == "bc" || st == "doc") out(NR, "", st == "doc" ? "x" : "c")
  while (i <= n) {
    c = substr(line, i, 1); c2 = substr(line, i, 2); c3 = substr(line, i, 3)
    if (st == "bc") {
      if (substr(line, i, length(bce)) == bce) { out(NR, bce, "c"); i += length(bce); st = bcret }
      else { out(NR, c, "c"); i++ }
      continue
    }
    if (st == "doc" || st == "str3") {
      if (c == "\\") { if (isdoc) dbuf[NR] = dbuf[NR] c2; i += 2; continue }
      if (c3 == sterm) {
        i += 3; st = "code"
        if (isdoc) {
          rest = substr(line, i)
          if (rest ~ /^[ \t]*(#.*)?$/) for (k = dstart; k <= NR; k++) out(k, dbuf[k], "d")
          isdoc = 0
        }
        continue
      }
      if (isdoc) dbuf[NR] = dbuf[NR] c
      i++; continue
    }
    if (st == "str") {
      if (sterm != "" && substr(line, i, length(sterm)) == sterm) { i += length(sterm); st = "code"; continue }
      if (sterm != "") { i++; continue }
      if (sesc != "" && c == sesc) { i += 2; continue }
      if (c == sq) {
        if (sesc == "" && substr(line, i + 1, 1) == sq && (f == "ps" || f == "sql" || f == "yaml" || vstr)) { i += 2; continue }
        st = "code"; vstr = 0; i++
        if (isdoc) {
          rest = substr(line, i)
          if (rest ~ /^[ \t]*(#.*)?$/) out(NR, dbuf[NR], "d")
          isdoc = 0
        }
        lastsig = ")"
        continue
      }
      if (isdoc) dbuf[NR] = dbuf[NR] c
      i++; continue
    }
    if (st == "tmpl") {
      if (c == "\\") { i += 2; continue }
      if (c == "`") { st = "code"; lastsig = ")"; i++; continue }
      if (c2 == "${") { tsp++; tstack[tsp] = bd; st = "code"; i += 2; continue }
      if (c2 == "/*" && (i == 1 || substr(line, i - 1, 1) ~ /[ \t]/)) { st = "bc"; bce = "*/"; bcret = "tmpl"; out(NR, c2, "c"); i += 2; continue }
      if (c2 == "//" && substr(line, 1, i - 1) ~ /^[ \t]*$/) {
        j = index(substr(line, i), "`")
        if (!j) { out(NR, substr(line, i), "c"); break }
        out(NR, substr(line, i, j - 1), "c"); i += j - 1; continue
      }
      i++; continue
    }
    if (st == "rx") {
      if (c == "\\") { i += 2; continue }
      if (c == "[") rxc = 1
      else if (c == "]") rxc = 0
      else if (c == "/" && !rxc) { st = "code"; lastsig = ")" }
      i++; continue
    }
    if (st == "lc") { out(NR, substr(line, i), "c"); break }
    if (f == "js" || f == "c" || f == "css" || f == "sql" || (f == "markup" && sub_ != "")) {
      g = f; if (f == "markup") g = sub_
      if (g == "js" && sub_ != "" && tolower(substr(line, i, 8)) == "</script") { sub_ = ""; i += 8; continue }
      if (g == "css" && sub_ != "" && tolower(substr(line, i, 7)) == "</style") { sub_ = ""; i += 7; continue }
      if (c2 == "/*") { st = "bc"; bce = "*/"; bcret = "code"; out(NR, c2, "c"); i += 2; continue }
      if (g == "sql" && c2 == "--") { st = "lc"; continue }
      if ((g == "js" || g == "c") && c2 == "//" && !(i > 1 && substr(line, i - 1, 1) == ":" && substr(line, i + 2, 1) ~ /[A-Za-z0-9]/)) { st = "lc"; continue }
      if (g == "c" && c3 == "\"\"\"") { open_str("", "", "\"\"\""); i += 3; continue }
      if (g == "c" && c2 == "@\"") { open_str("\"", "", ""); vstr = 1; i += 2; continue }
      if (c == "\"" || c == "\047") { open_str(c, (g == "sql" ? "" : "\\"), ""); i++; continue }
      if (g == "js" && c == "`") { st = "tmpl"; i++; continue }
      if (g == "js" && c == "{") { bd++; lastsig = c; i++; continue }
      if (g == "js" && c == "}") {
        if (tsp > 0 && bd == tstack[tsp]) { tsp--; st = "tmpl"; i++; continue }
        bd--; lastsig = c; i++; continue
      }
      if (g == "js" && c == "/") {
        pre = substr(line, 1, i - 1); sub(/[ \t]+$/, "", pre)
        ps = pre == "" ? lastsig : substr(pre, length(pre), 1)
        w = ""; if (match(pre, /[A-Za-z_$][A-Za-z0-9_$]*$/)) w = substr(pre, RSTART)
        if (ps == "" || index("(,=:[!&|?{};+-*%>~^", ps) || w ~ /^(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof)$/) { st = "rx"; rxc = 0; i++; continue }
      }
      if (c !~ /[ \t]/) lastsig = c
      i++; continue
    }
    if (f == "markup") {
      if (substr(line, i, 4) == "<!--") { st = "bc"; bce = "-->"; bcret = "code"; out(NR, "<!--", "c"); i += 4; continue }
      t = tolower(substr(line, i, 7))
      if (t ~ /^<script/ || t ~ /^<style/) {
        j = index(substr(line, i), ">")
        if (j) { sub_ = (t ~ /^<script/) ? "js" : "css"; i += j; continue }
      }
      i++; continue
    }
    if (f == "py") {
      if (c == "#") { st = "lc"; continue }
      if (c3 == "\"\"\"" || c3 == "\047\047\047") {
        pre = substr(line, 1, i - 1)
        isdoc = stmt_start(pre); dstart = NR; delete dbuf
        st = isdoc ? "doc" : "str3"; sterm = c3; i += 3; continue
      }
      if (c == "\"" || c == "\047") {
        pre = substr(line, 1, i - 1)
        isdoc = stmt_start(pre); delete dbuf
        open_str(c, "\\", ""); i++; continue
      }
      if (c == "(" || c == "[" || c == "{") depth++
      else if (c == ")" || c == "]" || c == "}") depth--
      i++; continue
    }
    if (f == "sh") {
      p = i == 1 ? " " : substr(line, i - 1, 1)
      if (c == "#" && p ~ /[ \t;&|()]/) { st = "lc"; continue }
      if (c == "\\") { i += 2; continue }
      if (c2 == "$\047") { open_str("\047", "\\", ""); i += 2; continue }
      if (c == "\047") { open_str(c, "", ""); i++; continue }
      if (c == "\"" || c == "`") { open_str(c, "\\", ""); i++; continue }
      if (c3 == "<<<") { i += 3; continue }
      pre = substr(line, 1, i - 1); opened = gsub(/\(\(/, "&", pre) - gsub(/\)\)/, "&", pre)
      if (c2 == "<<" && opened <= 0) {
        rest = substr(line, i + 2)
        if (match(rest, /^-?[ \t]*["\047]?[A-Za-z_][A-Za-z0-9_]*/)) {
          tok = substr(rest, 1, RLENGTH); hstrip = substr(tok, 1, 1) == "-"
          hscript = (pre " " substr(rest, RLENGTH + 1)) ~ /(^|[ \t;|&(\/])(sh|bash|zsh|dash|ksh|ssh|python[0-9.]*|node|pwsh|powershell|perl|ruby|psql|sqlite3)([ \t]|$)/
          gsub(/^-|[ \t"\047]/, "", tok); hterm = tok; pendh = 1; i += 2 + RLENGTH; continue
        }
      }
      i++; continue
    }
    if (f == "ps") {
      p = i == 1 ? " " : substr(line, i - 1, 1)
      if (c2 == "<#") { st = "bc"; bce = "#>"; bcret = "code"; out(NR, c2, "c"); i += 2; continue }
      if (c == "#" && p ~ /[ \t;|{}(),=]/) { st = "lc"; continue }
      if ((c2 == "@\"" || c2 == "@\047") && substr(line, i + 2) ~ /^[ \t]*$/) { st = "psh"; hterm = substr(c2, 2, 1) "@"; next }
      if (c == "\047") { open_str(c, "", ""); i++; continue }
      if (c == "\"") { open_str(c, "`", ""); i++; continue }
      i++; continue
    }
    if (f == "yaml") {
      p = i == 1 ? " " : substr(line, i - 1, 1)
      if (c == "#" && p ~ /[ \t]/) { st = "lc"; continue }
      if (c == "\"") { open_str(c, "\\", ""); i++; continue }
      if (c == "\047" && p ~ /[ \t:\[{,-]/) { open_str(c, "", ""); i++; continue }
      i++; continue
    }
    i++
  }
  if (st == "str" && sterm == "" && !vstr && f != "sh" && f != "ps" && f != "sql") { st = "code"; isdoc = 0 }
  if (st == "rx" || st == "lc") st = "code"
  if (f == "py") { t = line; sub(/[ \t]+$/, "", t); cont = (st == "code" && substr(t, length(t), 1) == "\\") }
  if (pendh) { pendh = 0; st = "here" }
  if (!fc) {
    t = line; gsub(/^[ \t]+|[ \t]+$/, "", t); u = txt[NR]; gsub(/^[ \t]+|[ \t]+$/, "", u)
    if (t != "" && !((NR in seen) && u == t)) fc = NR
  }
  if (lang == "yaml" && f == "yaml" && st == "code" && match(line, /^[ \t]*(- +)?[A-Za-z0-9_.\/"\047-]+:[ \t]*[|>][-+0-9]*[ \t]*(#.*)?$/)) {
    key = line; sub(/^[ \t]*(- +)?/, "", key); ybind = length(line) - length(key)
    sub(/:.*/, "", key); gsub(/["\047]/, "", key)
    yb = 1; yblang = key == "run" ? "sh" : key == "script" ? "js" : ""
  }
}
END {
  g = 0
  for (ln = 1; ln <= last; ln++) {
    if (!(ln in seen)) continue
    if (!((ln - 1) in seen)) g++
    printf "%d\t%d\t%s\t%d\t%s\n", ln, g, (kind[ln] == "d" ? "d" : "c"), (fc == 0 || ln < fc), txt[ln]
  }
}'
}

: >"$work/old"
cut -f1 "$work/removed" | sort -u | while IFS= read -r path; do
  lang=$(lang_of "$path" "$mb")
  [[ -n $lang ]] || continue
  git cat-file -p "$mb:$path" 2>/dev/null | lex "$lang" | awk -v p="$path" -v removedf="$work/removed" '
    function norm(s) {
      gsub(/\/\/+|\/\*+!?|\*+\/|<!--|-->|<#|#>|#+|"""|\047\047\047/, " ", s)
      sub(/^[ \t]*(\*+|--+|;+|::|[Rr][Ee][Mm])[ \t]/, " ", s)
      gsub(/[ \t]+/, " ", s); sub(/^ /, "", s); sub(/ $/, "", s)
      return s
    }
    BEGIN { while ((getline l < removedf) > 0) { split(l, a, "\t"); if (a[1] == p) gone[a[2]] = 1 } }
    ($1 in gone) { t = $0; for (k = 0; k < 4; k++) t = substr(t, index(t, "\t") + 1); t = norm(t); if (t != "") print t }'
done >"$work/old"

cut -f1 "$work/added" | sort -u >"$work/paths"
: >"$work/comments"
: >"$work/exempt"
while IFS= read -r path; do
  for rule in "${exceptions[@]}"; do
    IFS='|' read -r glob word _ <<<"$rule"
    # shellcheck disable=SC2254
    case $path in $glob) printf '%s\t%s\n' "$path" "$word" >>"$work/exempt" ;; esac
  done
  for rule in "${comment_exceptions[@]}"; do
    [[ $path == "${rule%%|*}" ]] && continue 2
  done
  lang=$(lang_of "$path")
  [[ -n $lang ]] || continue
  git cat-file -p "$head:$path" 2>/dev/null | lex "$lang" | awk -v p="$path" '{ print p "\t" $0 }' >>"$work/comments"
done <"$work/paths"

{
  while IFS= read -r sha; do
    git log -1 --format=%B "$sha" | awk -v s="commit ${sha:0:9}" '{ print s "\t" NR "\t" $0 }'
  done < <(git rev-list --no-merges "$mb..$head")
  [[ -z $title ]] || printf '%s\n' "$title" | awk '{ print "PR title\t" NR "\t" $0 }'
  [[ -z $body ]] || printf '%s\n' "$body" | tr -d '\r' | awk '
    /<!-- This is an auto-generated comment/ { bot = 1 }
    !bot { print "PR body\t" NR "\t" $0 }
    /<!-- end of auto-generated comment/ { bot = 0 }'
} >"$work/texts"

awk -v names="$names" -v conames="$coauthor_names" \
  -v exemptf="$work/exempt" -v oldf="$work/old" -v commentsf="$work/comments" \
  -v addedf="$work/added" -v textsf="$work/texts" '
function rest(s, k,   j) { while (k-- > 0) { j = index(s, "\t"); if (!j) return ""; s = substr(s, j + 1) } return s }
function strip(s) {
  sub(/^[ \t]+/, "", s)
  sub(/^(\/\/+|\/\*+|<!--|<#|#+|--+|;+|::|[Rr][Ee][Mm]([ \t]|$)|\*+)/, "", s)
  sub(/^[ \t]*\*+[ \t]/, "", s)
  sub(/(\*+\/|-->|#>)[ \t]*$/, "", s)
  gsub(/^[ \t]+|[ \t]+$/, "", s)
  return s
}
function norm(s) {
  gsub(/\/\/+|\/\*+!?|\*+\/|<!--|-->|<#|#>|#+|"""|\047\047\047/, " ", s)
  sub(/^[ \t]*(\*+|--+|;+|::|[Rr][Ee][Mm])[ \t]/, " ", s)
  gsub(/[ \t]+/, " ", s); sub(/^ /, "", s); sub(/ $/, "", s)
  return s
}
function directive(s, raw, line,   t) {
  t = tolower(s)
  if (t ~ /^eslint-(disable|enable)(-next-line|-line)?( |$)/ || t ~ /^eslint [@a-z0-9\/_-]+: *(off|warn|error|[012]|\[)/ || t ~ /^eslint-env [a-z]/) return 1
  if (raw ~ /^[ \t]*\/\*/ && t ~ /^(globals?|exported) [a-z_$][a-z0-9_$]*(:[a-z]+)?( *, *[a-z_$][a-z0-9_$]*(:[a-z]+)?)*$/) return 1
  if (t ~ /^(prettier-ignore|@vite-ignore|@ts-check|@ts-nocheck|nosonar|#__pure__|@__pure__|@__no_side_effects__)$/) return 1
  if (t ~ /^@ts-(expect-error|ignore)( |:|$)/ || t ~ /^\/? ?<reference (path|types|lib)=/ || t ~ /^webpack[a-z]+: /) return 1
  if (t ~ /^@jsx(importsource|frag|runtime)? [a-z@.]/ || t ~ /^(istanbul ignore (next|else|if|file)|[cv]8 ignore (next|start|stop|file|if|else))/) return 1
  if (t ~ /^@(vitest|jest)-environment [a-z]/ || t ~ /^biome-ignore [a-z]/ || t ~ /^stylelint-(disable|enable)/) return 1
  if (t ~ /^[#@] source(mapping)?url=/ || t ~ /^shellcheck (disable|enable|source|shell|external-sources)=/) return 1
  if (t ~ /^noqa(: *[a-z]+[0-9]+( *, *[a-z]+[0-9]+)*)?$/ || t ~ /^type: *ignore(\[|$)/ || t ~ /^pylint: *(disable|enable)=/) return 1
  if (t ~ /^pyright: *(ignore|basic|strict)/ || t ~ /^mypy: *(ignore|disable)/ || t ~ /^fmt: *(off|on|skip)$/ || t ~ /^isort: *(skip|off|on|dont-add)/) return 1
  if (t ~ /^pragma: no cover$/ || t ~ /^nosec( [a-z][0-9]+)*$/ || t ~ /^-\*- coding/ || t ~ /^vim?: *(set )?[a-z]+=/) return 1
  if (t ~ /^(syntax|escape)=/ || t ~ /^yaml-language-server: / || t ~ /^yamllint (disable|enable)/ || t ~ /^resharper (disable|restore)/) return 1
  if (t ~ /^noinspection [a-z]+$/ || t ~ /^@formatter:(on|off)$/ || t ~ /^checkstyle:(on|off)/ || t ~ /^go:(build|generate|embed|linkname|noinline)/) return 1
  if (t ~ /^\+build / || t ~ /^nolint(:[a-z,]+)?$/ || t ~ /^htmlhint [a-z-]+:/ || t ~ /^(cspell|spell-checker): *(disable|enable|ignore|words)/) return 1
  if (t ~ /^\[if / || t ~ /^<!\[endif/) return 1
  if (raw ~ /^[ \t]*(\/\/ ?)?#(end)?region([ \t]|$)/) return 1
  if (tolower(raw) ~ /^[ \t]*#requires[ \t]+-/) return 1
  if (t ~ /^v?[0-9]+(\.[0-9]+)*$/ && line ~ /uses:[ \t]*[^ \t]+@[0-9a-f]+[ \t]+#/) return 1
  if (t ~ /^(glsl|wgsl|html|css|sql|graphql|gql|js|ts)$/ && raw ~ /^[ \t]*\/\*/) return 1
  return 0
}
function license(s) {
  return tolower(s) ~ /spdx-license-identifier|copyright (\(c\)|©|[0-9][0-9][0-9][0-9])|^© |all rights reserved|@license|@preserve|the above copyright notice/
}
function licensebody(s) {
  return tolower(s) ~ /permission is hereby granted|licensed under the|gnu (general|lesser|affero) public license|apache license|the software is provided "as is"|redistribution and use in source/
}
function word(t, w) { return t ~ ("(^|[^a-z0-9_])" w "([^a-z0-9_]|$)") }
function named(s, path,   t, k, hit) {
  t = tolower(s); hit = ""
  for (k = 1; k <= nn; k++)
    if (word(t, nm[k]) && !((path SUBSEP nm[k]) in ex) && !((path SUBSEP "*") in ex)) hit = hit (hit == "" ? "" : ", ") nm[k]
  return hit
}
function labelled(s,   t, r, k) {
  t = tolower(s)
  if (t ~ /(^|[^a-z0-9_])ai[- ](generated|assisted|authored|written)([^a-z0-9_]|$)/) return 1
  while (match(t, /generated (with|by)/)) {
    r = substr(t, RSTART + RLENGTH, 63)
    if (r ~ /(^|[^a-z0-9_])(ai|t3)([^a-z0-9_]|$)/) return 1
    for (k = 1; k <= nn; k++) if (word(r, nm[k])) return 1
    for (k = 1; k <= nc; k++) if (word(r, cn[k])) return 1
    t = substr(t, RSTART + RLENGTH)
  }
  return 0
}
function coauthor(s,   t, k) {
  t = tolower(s)
  if (t !~ /^[ \t]*co-authored-by:/) return 0
  if (t ~ /\[bot\]|bot@|noreply@/) return 1
  for (k = 1; k <= nn; k++) if (word(t, nm[k])) return 1
  for (k = 1; k <= nc; k++) if (word(t, cn[k])) return 1
  return 0
}
function short(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return length(s) > 90 ? substr(s, 1, 87) "..." : s }
function say(where, why, s) { printf "%s: %s: %s\n", where, why, short(s); bad++ }
BEGIN {
  nn = split(names, nm, " "); nc = split(conames, cn, " ")
  while ((getline l < exemptf) > 0) { split(l, a, "\t"); ex[a[1] SUBSEP a[2]] = 1 }
  rs = RS; RS = "\001"
  corpus = ""
  if ((getline corpus < oldf) > 0) { }
  RS = rs
  gsub(/\n/, " ", corpus); corpus = " " corpus " "
  while ((getline l < commentsf) > 0) {
    split(l, a, "\t"); key = a[1] SUBSEP a[2]
    grp[key] = a[1] SUBSEP a[3]; knd[key] = a[4]; pre[key] = a[5]; ctx[key] = rest(l, 5)
    if (a[5] && licensebody(ctx[key])) lic[a[1] SUBSEP a[3]] = 1
  }
  while ((getline l < addedf) > 0) {
    split(l, a, "\t"); key = a[1] SUBSEP a[2]; text = rest(l, 2)
    if (key in ctx && !(pre[key] && (license(ctx[key]) || grp[key] in lic))) {
      s = strip(ctx[key]); m = norm(ctx[key])
      if (m != "" && !directive(s, ctx[key], text) && !index(corpus, " " m " "))
        say(a[1] ":" a[2], knd[key] == "d" ? "adds a docstring" : "adds a comment", s)
    }
    h = named(text, a[1])
    if (h != "") say(a[1] ":" a[2], "names an assistant or model (" h ")", text)
    else if (labelled(text) && !((a[1] SUBSEP "*") in ex)) say(a[1] ":" a[2], "carries an authorship label", text)
  }
  while ((getline l < textsf) > 0) {
    split(l, a, "\t"); text = rest(l, 2)
    where = a[1] (a[1] == "PR title" ? "" : " line " a[2])
    if (coauthor(text)) say(where, "credits an assistant, model or bot as co-author", text)
    else if ((h = named(text, "")) != "") say(where, "names an assistant or model (" h ")", text)
    else if (labelled(text)) say(where, "carries an authorship label", text)
  }
  if (bad) {
    printf "\n%d problem%s. Write the code so it reads without a comment (a clearer name, a smaller function, a test), keep existing comments, and keep authorship credits out of the repo and the PR.\n", bad, bad == 1 ? "" : "s"
    exit 1
  }
  print "No new comments and no authorship credits."
}'
