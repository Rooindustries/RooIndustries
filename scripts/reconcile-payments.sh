#!/usr/bin/env bash
set -euo pipefail
umask 077
script_dir=$(cd "$(dirname "$0")" && pwd)
module_dir="$script_dir/lib"
run=$(date -u +%F)
at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
state_dir="${ROO_RECONCILE_STATE_DIR:-$HOME/.local/state/roo-reconcile}"
alert_file="${ROO_RECONCILE_ALERT_FILE:-$HOME/.local/share/mission-control/alerts/site-reconcile.json}"
token_file="${ROO_RECONCILE_TOKEN_FILE:-$HOME/.config/roo/reconcile-token}"
url="${ROO_RECONCILE_URL:-https://www.rooindustries.com/api/payment/report}"
executor="${ROO_RECONCILE_EXECUTOR_BIN:-}"
result=unavailable
error_code=job_unavailable
reported_count=0
listed_count=0
open_count=0
unknown_count=0
recovered_count=0
complete=false
update_url=""
work=""

bootstrap_fail() {
  printf '%s\n' '{"result":"unavailable","complete":false}'
  exit 1
}
for tool in jq curl timeout flock realpath stat mktemp; do
  command -v "$tool" >/dev/null || bootstrap_fail
done
jq_module() {
  jq -L "$module_dir" "$@"
}
valid_path() {
  [[ "$1" == /* && "$1" != / && "$1" != *$'\n'* && "$1" != *$'\r'* &&
    "$(realpath -m -- "$1")" == "$1" && ! -L "$1" ]]
}
valid_path "$state_dir" && valid_path "$alert_file" && valid_path "$token_file" || bootstrap_fail
mkdir -p -- "$state_dir" "$(dirname "$alert_file")" || bootstrap_fail
[[ "$(stat -c %u "$state_dir")" == "$(id -u)" ]] || bootstrap_fail
(( (8#$(stat -c %a "$state_dir") & 077) == 0 )) || bootstrap_fail
exec 9>"$state_dir/job.lock"
if ! flock -n 9; then
  jq -nc --arg run "$run" '{run:$run,result:"retry",reportedCount:0,listedCount:0,open:0,unknown:0,recovered:0,complete:false,updateURL:"",ownedissueURLs:[]}'
  exit 75
fi
work=$(mktemp -d "$state_dir/.run.XXXXXX")
printf '[]\n' > "$work/urls.json"
output() {
  jq -nc --arg run "$run" --arg result "$result" --arg updateURL "$update_url" \
    --argjson reportedCount "$reported_count" --argjson listedCount "$listed_count" \
    --argjson open "$open_count" --argjson unknown "$unknown_count" --argjson recovered "$recovered_count" \
    --argjson complete "$complete" --slurpfile urls "$work/urls.json" \
    '{run:$run,result:$result,reportedCount:$reportedCount,listedCount:$listedCount,
      open:$open,unknown:$unknown,recovered:$recovered,complete:$complete,updateURL:$updateURL,ownedissueURLs:$urls[0]}'
}
finish() {
  local status="$?"
  trap - EXIT
  if (( status != 0 )); then
    result=unavailable
    complete=false
  fi
  if [[ -f "$work/verified.json" ]]; then open_count=$(known_open); fi
  output > "$work/result.json"
  jq '. + {version:1}' "$work/result.json" > "$work/run.json"
  mv -f -- "$work/run.json" "$state_dir/run-$run.json"
  jq -nc --arg at "$at" --arg result "$result" --arg code "$error_code" \
    --argjson count "$reported_count" --slurpfile source "$work/window.json" \
    '{card:"site",severity:(if $result=="clear" then "green" elif $result=="mismatch" then "red" else "amber" end),
      title:"Payments vs bookings vs referral credits",at:$at,stale_after_hours:26,count:$count,
      items:(if $source[0]!=null then $source[0].items else
        [{key:"scan:source",id:"report",ref:"",amount:"",currency:"",reason:$code}] end)}' > "$work/alert.json"
  mv -f -- "$work/alert.json" "$alert_file"
  cat "$work/result.json"
  find "$work" -maxdepth 1 -type f -delete
  rmdir -- "$work"
  exit "$status"
}
printf 'null\n' > "$work/window.json"
trap finish EXIT
fail() {
  error_code="$1"
  exit 1
}
known_open() {
  jq '[.[]|select(.archivedAt==null and .statusType!="completed" and .statusType!="canceled")]|length' "$work/verified.json"
}
remember_issue() {
  printf '%s' "$1" | jq '{uuid,statusType,archivedAt}' > "$work/verified-issue.json"
  jq -c --slurpfile issue "$work/verified-issue.json" 'map(select(.uuid!=$issue[0].uuid))+$issue' "$work/verified.json" > "$work/verified-next.json"
  mv "$work/verified-next.json" "$work/verified.json"
}
if [[ -z "$executor" ]]; then executor=$(command -v executor) || fail executor_unavailable; fi
valid_path "$executor" && [[ -x "$executor" ]] || fail executor_unavailable
protocol='=https'
case "${ROO_RECONCILE_TEST_MODE:-0}" in 0|1) ;; *) fail configuration_invalid ;; esac
if [[ "${ROO_RECONCILE_TEST_MODE:-0}" == 1 ]]; then
  [[ "$url" =~ ^http://([0-9]{1,3}(\.[0-9]{1,3}){3}):([0-9]{1,5})/api/payment/report$ ]] || fail test_origin_invalid
  address="${BASH_REMATCH[1]}"
  port="${BASH_REMATCH[3]}"
  IFS=. read -r first second third fourth <<< "$address"
  for octet in "$first" "$second" "$third" "$fourth"; do
    [[ "$octet" == 0 || "$octet" =~ ^[1-9][0-9]{0,2}$ ]] || fail test_origin_invalid
    (( octet <= 255 )) || fail test_origin_invalid
  done
  (( port >= 1024 && port <= 65535 )) || fail test_origin_invalid
  (( first == 10 || first == 127 || (first == 192 && second == 168) ||
    (first == 172 && second >= 16 && second <= 31) ||
    (first == 100 && second >= 64 && second <= 127) )) || fail test_origin_invalid
  origin="${url%/api/payment/report}"
  timeout 15 "$executor" --reconcile-test-handshake "$origin" > "$work/handshake.json" 2>/dev/null || fail test_connection_invalid
  jq -e --arg origin "$origin" '. == {rooReconcileFixture:1,origin:$origin}' "$work/handshake.json" >/dev/null 2>&1 || fail test_connection_invalid
  protocol='=http'
  if [[ -n "${ROO_RECONCILE_DATE:-}" ]]; then
    [[ "$ROO_RECONCILE_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ &&
      "$(date -u -d "$ROO_RECONCILE_DATE" +%F 2>/dev/null)" == "$ROO_RECONCILE_DATE" ]] || fail test_date_invalid
    run="$ROO_RECONCILE_DATE"
  fi
else
  [[ "$url" == https://www.rooindustries.com/api/payment/report && -z "${ROO_RECONCILE_DATE:-}" ]] || fail configuration_invalid
fi
token=""
token_ok=false
read_token() {
  [[ -f "$token_file" && -r "$token_file" && "$(stat -c %u "$token_file")" == "$(id -u)" ]] || return 1
  (( (8#$(stat -c %a "$token_file") & 077) == 0 )) || return 1
  token=$(cat "$token_file") || return 1
  [[ "${#token}" -ge 32 && "${#token}" -le 128 && "$token" =~ ^[A-Za-z0-9._~+/-]+=*$ ]]
}
if read_token; then token_ok=true; fi
linear_call() {
  local method="$1" payload="$2"
  case "$method" in
    get_issue|list_issues|list_comments|get_status_updates|save_issue|save_comment|save_status_update) ;;
    *) return 1 ;;
  esac
  timeout 30 "$executor" call tools linear org linear "$method" "$payload" > "$work/cli.json" 2>/dev/null || return 1
  jq_module -ce 'include "reconcile-linear"; unwrap' "$work/cli.json" 2>/dev/null
}
all_pages() {
  local method="$1" args="$2" field="$3" cursor="" seen='[]' pages=0 page
  local all_file="$work/page-all.json" rows_file="$work/page-rows.json" next_file="$work/page-next.json"
  printf '[]\n' > "$all_file"
  while (( pages < 50 )); do
    page=$(linear_call "$method" "$args") || return 1
    printf '%s' "$page" | jq_module -e --arg field "$field" 'include "reconcile-linear"; page_valid($field)' >/dev/null 2>&1 || return 1
    printf '%s' "$page" | jq -c --arg field "$field" '.[$field]' > "$rows_file"
    jq_module -e 'include "reconcile-linear"; map(.uuid // .id) | all(.[];uuid) and distinct' "$rows_file" >/dev/null || return 1
    jq -s '.[0]+.[1]' "$all_file" "$rows_file" > "$next_file"
    mv "$next_file" "$all_file"
    jq -e 'map(.uuid // .id)|length==(unique|length)' "$all_file" >/dev/null || return 1
    if [[ "$(printf '%s' "$page" | jq -r .hasNextPage)" == false ]]; then cat "$all_file"; return; fi
    cursor=$(printf '%s' "$page" | jq -r .cursor)
    printf '%s' "$seen" | jq -e --arg cursor "$cursor" 'index($cursor)==null' >/dev/null || return 1
    seen=$(printf '%s' "$seen" | jq -c --arg cursor "$cursor" '.+[$cursor]')
    args=$(printf '%s' "$args" | jq -c --arg cursor "$cursor" '.+{cursor:$cursor}')
    pages=$((pages+1))
  done
  return 1
}
root_issue=$(linear_call get_issue '{"id":"ROO-498"}') || fail linear_unavailable
printf '%s' "$root_issue" | jq_module -e 'include "reconcile-linear"; root_scope' >/dev/null || fail linear_scope_invalid
issues_args=$(jq_module -nc 'include "reconcile-linear"; scope | {parentId,project:.projectId,team:.teamId,limit:100,includeArchived:true,fields:["id","uuid","description","projectId","teamId","parentId","status","statusType","archivedAt","createdAt","updatedAt","url"]}')
all_pages list_issues "$issues_args" issues > "$work/issues.json" || fail linear_pagination_invalid
jq_module -e 'include "reconcile-linear"; all(.[];issue_scope)' "$work/issues.json" >/dev/null || fail linear_scope_invalid
jq_module -c 'include "reconcile-linear"; [.[]|owned_issue]' "$work/issues.json" > "$work/owned.json" || fail linear_identity_invalid
jq -c 'map(.url)|unique' "$work/owned.json" > "$work/urls.json"
jq '[.[]|{uuid,statusType,archivedAt}]' "$work/owned.json" > "$work/verified.json"
printf '[]\n' > "$work/managed.json"
while IFS= read -r issue; do
  issue_id=$(printf '%s' "$issue" | jq -r .uuid)
  comment_args=$(jq -nc --arg issueId "$issue_id" '{issueId:$issueId,limit:100,orderBy:"updatedAt"}')
  comments=$(all_pages list_comments "$comment_args" comments) || fail linear_pagination_invalid
  managed=$(printf '%s' "$comments" | jq_module -c --argjson issue "$issue" --arg run "$run" 'include "reconcile-linear"; with_comment($issue;$run)') || fail linear_identity_invalid
  jq -c --argjson managed "$managed" '.+[$managed]' "$work/managed.json" > "$work/next.json"
  mv "$work/next.json" "$work/managed.json"
done < <(jq -c '.[]' "$work/owned.json")
updates_args=$(jq_module -nc --arg createdAt "$run"'T00:00:00Z' 'include "reconcile-linear"; {type:"project",project:scope.projectId,limit:100,orderBy:"createdAt",createdAt:$createdAt}')
load_updates() {
  all_pages get_status_updates "$updates_args" statusUpdates > "$work/updates.json" || return 1
  jq_module -e 'include "reconcile-linear"; all(.[];update_scope)' "$work/updates.json" >/dev/null || return 1
}
load_updates || fail linear_scope_invalid
marker="Reconciliation run: $run"
jq -c --arg marker "$marker" '[.[]|select(.body|split("\n")|index($marker)!=null)]' "$work/updates.json" > "$work/today.json"
[[ "$(jq length "$work/today.json")" -le 1 ]] || fail linear_run_ambiguous
jq -e --arg marker "$marker" 'all(.[];([.body|split("\n")[]|select(.==$marker)]|length)==1)' "$work/today.json" >/dev/null || fail linear_run_ambiguous
update_id=$(jq -r '.[0].id // ""' "$work/today.json")
save_update() {
  local body="$1" args response
  if [[ -n "$update_id" ]]; then
    args=$(jq -nc --arg id "$update_id" --arg body "$body" '{id:$id,body:$body}')
  else
    args=$(jq_module -nc --arg body "$body" 'include "reconcile-linear"; {type:"project",project:scope.projectId,body:$body}')
  fi
  response=$(linear_call save_status_update "$args") || return 1
  printf '%s' "$response" | jq_module -e 'include "reconcile-linear"; update_scope' >/dev/null || return 1
  if [[ -n "$update_id" ]]; then
    [[ "$(printf '%s' "$response" | jq -r .id)" == "$update_id" ]] || return 1
  else update_id=$(printf '%s' "$response" | jq -r .id); fi
  load_updates || return 1
  jq -e --arg id "$update_id" --arg body "$body" --arg marker "$marker" \
    '[.[]|select(.body|split("\n")|index($marker)!=null)] as $day |
      ($day|length)==1 and $day[0].id==$id and $day[0].body==$body' "$work/updates.json" >/dev/null || return 1
  update_url=$(printf '%s' "$response" | jq -r .url)
}
save_update "$marker"$'\nPayment audit: pending.' || fail linear_update_unverified
fetch_report() {
  local destination="$1" keys="${2:-}" status
  [[ "$token_ok" == true ]] || return 1
  local -a query=()
  if [[ -n "$keys" ]]; then query=(--get --data-urlencode "check=$keys"); fi
  status=$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl --config - --silent --show-error --fail-with-body --max-time 45 --max-redirs 0 \
      --proto "$protocol" --output "$destination" --write-out '%{http_code}' "${query[@]}" "$url" 2>/dev/null) || return 1
  [[ "$status" == 200 ]]
}
source_ok=true
if ! fetch_report "$work/source.json" || ! jq_module -e 'include "reconcile-linear"; valid_window' "$work/source.json" >/dev/null 2>&1; then
  source_ok=false
  error_code=report_source_unavailable
else cp "$work/source.json" "$work/window.json"; fi
jq_module -c --slurpfile window "$work/window.json" 'include "reconcile-linear"; select_targets($window[0] // {items:[]})' "$work/managed.json" > "$work/eligible.json"
coverage=$(jq 'length<=200' "$work/eligible.json")
printf '[]\n' > "$work/checks.json"
targets_ok=true
if [[ "$source_ok" == true ]]; then
  total=$(jq 'length|if .>200 then 200 else . end' "$work/eligible.json")
  for (( offset=0; offset<total; offset+=20 )); do
    keys=$(jq -c --argjson offset "$offset" '.[$offset:$offset+20]' "$work/eligible.json")
    if ! fetch_report "$work/target.json" "$keys" ||
      ! jq_module -e --argjson requested "$keys" 'include "reconcile-linear"; valid_targets($requested)' "$work/target.json" >/dev/null 2>&1; then
      targets_ok=false
      error_code=report_targets_unavailable
      printf '[]\n' > "$work/checks.json"
      break
    fi
    jq -c --slurpfile target "$work/target.json" '.+$target[0].checks' "$work/checks.json" > "$work/next.json"
    mv "$work/next.json" "$work/checks.json"
  done
else targets_ok=false; fi
at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq_module -nc --slurpfile window "$work/window.json" --slurpfile managed "$work/managed.json" --slurpfile checks "$work/checks.json" \
  --argjson sourceOK "$source_ok" --argjson targetsOK "$targets_ok" --argjson coverage "$coverage" --arg run "$run" --arg at "$at" \
  'include "reconcile-linear"; plan($window[0];$managed[0];$checks[0];$sourceOK;$targetsOK;$coverage;$run;$at)' > "$work/plan.json"
reported_count=$(jq .reportedCount "$work/plan.json")
listed_count=$(jq .listedCount "$work/plan.json")
open_count=$(known_open)
unknown_count=$(jq .unknown "$work/plan.json")
recovered_count=0
while IFS= read -r action; do
  issue=$(printf '%s' "$action" | jq -c .issue)
  primary=$(printf '%s' "$action" | jq -r .primary)
  comment_id=$(printf '%s' "$issue" | jq -r '.commentId // ""')
  if [[ "$issue" == null ]]; then
    args=$(jq_module -nc --arg key "$primary" --arg updateURL "$update_url" 'include "reconcile-linear"; {
      title:("Resolve payment reconciliation: "+$key),team:scope.teamId,project:scope.projectId,parentId:scope.parentId,
      assignee:"me",priority:1,state:"Backlog",
      description:("**Goal**: Resolve this payment, booking or referral-credit mismatch.\n\n**Done when**: The read-only payment audit confirms this entity is consistent.\n\n**Evidence**:\nReconciliation key: "+$key+"\nDaily report: "+$updateURL+"\n\n**Constraints**: Keep payment and booking data unchanged. Investigate in fixtures or test mode; do not issue refunds or alter customer prices.\n\nSession: RooIndustries payment reconciliation")}')
    expected_description=$(printf '%s' "$args" | jq -r .description)
    created=$(linear_call save_issue "$args") || fail linear_issue_unverified
    printf '%s' "$created" | jq_module -e 'include "reconcile-linear"; issue_scope' >/dev/null || fail linear_issue_unverified
    issue_id=$(printf '%s' "$created" | jq -r .uuid)
    get_args=$(jq -nc --arg id "$issue_id" '{id:$id}')
    issue=$(linear_call get_issue "$get_args") || fail linear_issue_unverified
    printf '%s' "$issue" | jq_module -e --arg id "$issue_id" --arg key "$primary" --arg description "$expected_description" 'include "reconcile-linear"; issue_scope and .uuid==$id and .description==$description and .status=="Backlog" and ([(owned_issue|.primary)]==[$key])' >/dev/null || fail linear_issue_unverified
  fi
  issue_id=$(printf '%s' "$issue" | jq -r .uuid)
  get_args=$(jq -nc --arg id "$issue_id" '{id:$id}')
  fresh=$(linear_call get_issue "$get_args") || fail linear_issue_unverified
  printf '%s' "$fresh" | jq_module -e --arg id "$issue_id" --arg key "$primary" \
    'include "reconcile-linear"; issue_scope and .uuid==$id and .archivedAt==null and ([(owned_issue|.primary)]==[$key])' >/dev/null || fail linear_issue_unverified
  remember_issue "$fresh"
  fresh_owned=$(printf '%s' "$fresh" | jq_module -c 'include "reconcile-linear"; owned_issue')
  args=$(jq -nc --arg issueId "$issue_id" '{issueId:$issueId,limit:100,orderBy:"updatedAt"}')
  comments=$(all_pages list_comments "$args" comments) || fail linear_comment_unverified
  fresh_owned=$(printf '%s' "$comments" | jq_module -c --argjson issue "$fresh_owned" --arg run "$run" 'include "reconcile-linear"; with_comment($issue;$run)') || fail linear_comment_unverified
  [[ "$(printf '%s' "$fresh_owned" | jq -r .invalidMetadata)" == false ]] || fail linear_comment_unverified
  if [[ "$(printf '%s' "$action" | jq -c .issue)" != null ]]; then
    printf '%s' "$fresh_owned" | jq -e --argjson issue "$issue" '.meta==$issue.meta and .commentId==$issue.commentId' >/dev/null || fail linear_comment_changed
  fi
  comment_id=$(printf '%s' "$fresh_owned" | jq -r '.commentId // ""')
  body=$(jq_module -nr --argjson action "$action" --argjson issue "$issue" --arg run "$run" 'include "reconcile-linear"; comment_body($action;$issue;$run)')
  if [[ -n "$comment_id" ]]; then
    args=$(jq -nc --arg id "$comment_id" --arg body "$body" '{id:$id,body:$body}')
  else args=$(jq -nc --arg issueId "$issue_id" --arg body "$body" '{issueId:$issueId,body:$body}'); fi
  saved=$(linear_call save_comment "$args") || fail linear_comment_unverified
  printf '%s' "$saved" | jq_module -e 'include "reconcile-linear"; .id|uuid' >/dev/null || fail linear_comment_unverified
  saved_id=$(printf '%s' "$saved" | jq -r .id)
  [[ -z "$comment_id" || "$saved_id" == "$comment_id" ]] || fail linear_comment_unverified
  args=$(jq -nc --arg issueId "$issue_id" '{issueId:$issueId,limit:100,orderBy:"updatedAt"}')
  comments=$(all_pages list_comments "$args" comments) || fail linear_comment_unverified
  printf '%s' "$comments" | jq -e --arg id "$saved_id" --arg body "$body" \
    '[.[]|select(.body|startswith("Payment reconciliation status\n"))] as $owned |
      ($owned|length)==1 and $owned[0].id==$id and $owned[0].body==$body' >/dev/null || fail linear_comment_unverified
  change=$(printf '%s' "$action" | jq -r '.changeState // ""')
  if [[ "$change" == Backlog && "$(printf '%s' "$fresh" | jq -r .statusType)" != completed ]]; then change=""; fi
  if [[ -n "$change" ]]; then
    args=$(jq -nc --arg id "$issue_id" --arg state "$change" '{id:$id,state:$state}')
    linear_call save_issue "$args" >/dev/null || fail linear_issue_unverified
    args=$(jq -nc --arg id "$issue_id" '{id:$id}')
    fresh=$(linear_call get_issue "$args") || fail linear_issue_unverified
    printf '%s' "$fresh" | jq_module -e --arg id "$issue_id" --arg state "$change" \
      'include "reconcile-linear"; issue_scope and .uuid==$id and .status==$state' >/dev/null || fail linear_issue_unverified
    remember_issue "$fresh"
    if [[ "$change" == Done ]]; then recovered_count=$((recovered_count+1)); fi
  fi
  compact_id=$(printf '%s' "$issue" | jq -r .id)
  jq -c --arg url "https://linear.app/rooindustries/issue/$compact_id" '.+[$url]|unique' "$work/urls.json" > "$work/next.json"
  mv "$work/next.json" "$work/urls.json"
done < <(jq -c '.actions[]' "$work/plan.json")
complete=$(jq .complete "$work/plan.json")
open_count=$(known_open)
result=$(jq -r .result "$work/plan.json")
body="$marker"$'\n'"Payment audit: $result. Reported: $reported_count; listed: $listed_count; open: $open_count; unknown: $unknown_count; recovered: $recovered_count. Incomplete: $([[ "$complete" == true ]] && printf false || printf true)."
while IFS= read -r issue_url; do body+=$'\n'"$issue_url"; done < <(jq -r '.[:20][]' "$work/urls.json")
if [[ "$(jq length "$work/urls.json")" -gt 20 ]]; then body+=$'\n''Full issue list: https://linear.app/rooindustries/issue/ROO-498'; fi
save_update "$body" || fail linear_update_unverified
if [[ "$source_ok" != true || "$targets_ok" != true || "$(jq .metadataInvalid "$work/plan.json")" == true ]]; then exit 1; fi
error_code=""
