def scope:
  {parentId:"d5c5564e-7966-4c7a-b360-d193ee81296c",
   projectId:"edd95e95-8bc5-473c-a116-dc5646d79a87",
   teamId:"9c69fa12-a33b-4072-99e8-a53f6f378104"};
def uuid: type == "string" and test("^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\\z");
def identity: type == "string" and test("^[A-Za-z0-9_.:/-]{1,80}\\z");
def empty_identity: . == "" or identity;
def target_key: type == "string" and test("^(payment|booking|record):[A-Za-z0-9_.:/-]{1,80}\\z");
def source_key:
  target_key or IN("scan:dodo-payments","scan:dodo-bookings","scan:dodo-records","scan:identity-invalid");
def managed_key: source_key or IN("scan:items","scan:targets","scan:source","scan:linear-identity");
def epoch: sub("\\.[0-9]+Z$";"Z") | fromdateiso8601;
def timestamp:
  type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z\\z")
  and (try (epoch | type == "number") catch false);
def exact($fields): type == "object" and (keys == ($fields | sort));
def distinct: length == (unique | length);
def owner_codes:
  ["dodo_payment_binding_mismatch","dodo_environment_mismatch","dodo_currency_mismatch",
   "dodo_amount_mismatch","dodo_product_mismatch","dodo_payment_details_incomplete",
   "dodo_refund_details_incomplete","dodo_refund_mismatch","dodo_payment_disputed",
   "dodo_dispute_lost_owner_review","dodo_dispute_accepted_owner_review",
   "dodo_dispute_expired_owner_review","dodo_payment_failed","dodo_payment_cancelled",
   "provider_partial_refund_details_missing_owner_review",
   "provider_order_not_found_after_late_capture_watch","unknown"];
def source_reason:
  . as $reason |
  (["payment_without_record","payment_record_mismatch","payment_without_booking",
    "frozen_pricing_unavailable","amount_mismatch","refund_not_applied","dispute_not_applied",
    "referral_binding_mismatch","commission_exceeds_kept_share","commission_mismatch",
    "booking_without_payment","report_truncated","report_identity_invalid",
    "payment_not_found","payment_not_succeeded","dodo_payment_binding_mismatch",
    "dodo_environment_mismatch","dodo_currency_mismatch","dodo_amount_mismatch",
    "dodo_product_mismatch","dodo_payment_details_incomplete"] +
   [owner_codes[] | ("owner_review_" + .)[0:60]] | index($reason)) != null;
def local_reason:
  IN("report_items_incomplete","report_targets_incomplete","report_source_unavailable","report_linear_identity_ambiguous");
def safe_item($local):
  exact(["key","id","ref","amount","currency","reason"])
  and (.key | if $local then managed_key else source_key end)
  and (.id | empty_identity) and (.ref | empty_identity)
  and (.amount | type == "string" and (. == "" or test("^-?[0-9]+\\.[0-9]{2}\\z")))
  and (.currency | type == "string" and (. == "" or test("^[A-Z]{3}\\z")))
  and (.reason | source_reason or ($local and local_reason));
def report_base:
  exact(["ok","at","from","to","mode","checks","complete","count","items"])
  and .ok == true and (.at | timestamp) and (.from | timestamp) and (.to | timestamp)
  and ((now - (.at | epoch)) >= 0) and ((now - (.at | epoch)) <= 900)
  and ((((.at|epoch) - (.from|epoch)) - 259200) | fabs) <= 1
  and ((((.at|epoch) - (.to|epoch)) - 1800) | fabs) <= 1
  and (.complete | exact(["payments","bookings","records","items"]) and all(.[]; type == "boolean"))
  and (.count | type == "number" and . >= 0 and . == floor)
  and (.items | type == "array" and all(.[];safe_item(false)) and distinct)
  and (.items | length) == ([.count,50] | min)
  and .complete.items == (.count <= 50);
def valid_window:
  report_base and .mode == "window" and .checks == [];
def canonical_aliases:
  type == "array" and length == 3 and distinct
  and all(.[];target_key)
  and ([.[]|split(":")[0]]|sort) == ["booking","payment","record"];
def valid_check:
  exact(["key","state","keys","items"]) and (.key | target_key)
  and (.keys | type == "array" and distinct and all(.[];source_key))
  and (. as $c | .keys | index($c.key) != null)
  and (.items | type == "array" and all(.[];safe_item(false)) and distinct)
  and (
    if .state == "recovered" then .items == [] and (.keys | canonical_aliases)
    elif .state == "unknown" then .items == [] and .keys == [.key]
    elif .state == "unresolved" then (.items | length) > 0
      and (. as $c | all(.items[]; .key as $key | $c.keys | index($key) != null))
    else false end
  );
def ordered_unique:
  reduce .[] as $entry ([]; if index($entry) == null then . + [$entry] else . end);
def valid_targets($requested):
  . as $report | report_base and .mode == "checks"
  and .complete.payments == false and .complete.bookings == false and .complete.records == false
  and (.checks | type == "array" and all(.[];valid_check))
  and [.checks[].key] == $requested
  and (([.checks[].items[]] | ordered_unique) as $observed |
    ($observed | length) == $report.count and $observed[:50] == $report.items);
def unwrap:
  if type != "object" or .ok != true or has("error") or has("errors")
    or .data.isError == true or .data.success == false or .data.ok == false or (.data|has("error") or has("errors"))
    or (.data.content | type) != "array" or (.data.content|length) != 1
    or .data.content[0].type != "text" then error("linear_response_invalid")
  else .data.content[0].text | fromjson |
    if type != "object" or has("error") or has("errors") or .success == false or .isError == true or .ok == false
      or . == {} then error("linear_payload_invalid") else . end
  end;
def root_scope:
  .id == "ROO-498" and .uuid == scope.parentId and .projectId == scope.projectId and .teamId == scope.teamId;
def issue_scope:
  (.uuid|uuid) and (.id|type == "string" and test("^ROO-[0-9]+\\z"))
  and .parentId == scope.parentId and .projectId == scope.projectId and .teamId == scope.teamId
  and (.description|type == "string") and (.status|type == "string")
  and (.statusType|IN("triage","backlog","unstarted","started","completed","canceled"))
  and (.createdAt|timestamp) and (.updatedAt|timestamp)
  and (.archivedAt == null or (.archivedAt|timestamp));
def update_scope:
  (.id|uuid) and .type == "project" and .project.id == scope.projectId
  and (.body|type == "string") and (.createdAt|timestamp)
  and (.url|type == "string" and test("^https://linear[.]app/rooindustries/project/[A-Za-z0-9/-]+(#[A-Za-z0-9-]+)?\\z"));
def page_valid($field):
  (.[$field]|type == "array") and (.hasNextPage|type == "boolean")
  and (if .hasNextPage then (.cursor|uuid) and (.[$field]|length)>0 else (.cursor // null)==null end);
def metadata_valid($issue):
  exact(["version","issueId","primary","keys","firstSeen","lastSeen","lastCheckedAt","state","run","observations"])
  and .version == 1 and .issueId == $issue.uuid and .primary == $issue.primary
  and (.keys|type == "array" and distinct and all(.[];managed_key))
  and (. as $m | .keys|index($m.primary)!=null)
  and (.firstSeen|timestamp) and (.lastSeen|timestamp) and (.lastCheckedAt|timestamp)
  and (.state|IN("unresolved","unknown","recovered","incomplete"))
  and (.run|type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}\\z"))
  and (.observations|type == "array" and all(.[];safe_item(true)));
def owned_issue:
  . as $issue |
  [.description|split("\n")[]|select(startswith("Reconciliation key: "))] as $markers |
  if ($markers|length)==0 then empty
  elif ($markers|length)!=1 then error("linear_identity_invalid")
  else ($markers[0]|ltrimstr("Reconciliation key: ")) as $primary |
    if ($primary|managed_key|not) then error("linear_identity_invalid")
    else {id:$issue.id,uuid:$issue.uuid,primary:$primary,status:$issue.status,statusType:$issue.statusType,
      archivedAt:$issue.archivedAt,createdAt:$issue.createdAt,
      url:("https://linear.app/rooindustries/issue/"+$issue.id)} end
  end;
def with_comment($issue;$run):
  [.[]|select((.body|type)=="string" and (.body|startswith("Payment reconciliation status\n")))] as $comments |
  if ($comments|length)>1 then $issue+{invalidMetadata:true,commentId:null,meta:null}
  elif ($comments|length)==0 then
    $issue+{invalidMetadata:false,commentId:null,meta:{
      version:1,issueId:$issue.uuid,primary:$issue.primary,keys:[$issue.primary],
      firstSeen:$issue.createdAt,lastSeen:$issue.createdAt,lastCheckedAt:$issue.createdAt,
      state:"incomplete",run:$run,observations:[]}}
  else $comments[0] as $comment |
    (try ($comment.body|split("\n")|if length==2 and (.[1]|startswith("Reconciliation: "))
      then .[1]|ltrimstr("Reconciliation: ")|fromjson else null end) catch null) as $meta |
    if ($comment.id|uuid) and ($meta|metadata_valid($issue)) then
      $issue+{invalidMetadata:false,commentId:$comment.id,meta:$meta}
    else $issue+{invalidMetadata:true,commentId:null,meta:null} end
  end;
def closed: .statusType == "completed" or .statusType == "canceled";
def outcome($checks;$issue): first($checks[]|select(.key==$issue.primary)) // null;
def candidates($issues;$checks;$key):
  [$issues[] as $issue | outcome($checks;$issue) as $proof |
    select($issue.primary==$key or ($proof!=null and $proof.state!="unknown" and ($proof.keys|index($key)!=null))
      or (($issue.meta.keys // [] | index($key)!=null) and ($proof==null or $proof.state!="recovered"))) |
    {issue:$issue,verified:($issue.primary==$key or ($proof!=null and $proof.state!="unknown" and ($proof.keys|index($key)!=null)))}];
def select_targets($window):
  [.[]|select(.primary|target_key)|select(.invalidMetadata|not)|
    select((.archivedAt==null and (closed|not)) or .meta.state!="recovered" or (. as $issue | any($window.items[]?;
      .key as $key | ($issue.meta.keys|index($key)!=null))))] |
  sort_by(.meta.lastCheckedAt,.uuid) | map(.primary) | ordered_unique;
def op_item($key;$reason):
  {key:$key,id:($key|ltrimstr("scan:")),ref:"",amount:"",currency:"",reason:$reason};
def operation_faults($window;$sourceOK;$targetsOK;$coverage;$ambiguous):
  [
    if $sourceOK|not then op_item("scan:source";"report_source_unavailable") else empty end,
    if $sourceOK and ($window.complete.payments|not) then op_item("scan:dodo-payments";"report_truncated") else empty end,
    if $sourceOK and ($window.complete.bookings|not) then op_item("scan:dodo-bookings";"report_truncated") else empty end,
    if $sourceOK and ($window.complete.records|not) then op_item("scan:dodo-records";"report_truncated") else empty end,
    if $sourceOK and ($window.complete.items|not) then op_item("scan:items";"report_items_incomplete") else empty end,
    if ($coverage|not) or ($targetsOK|not) then op_item("scan:targets";"report_targets_incomplete") else empty end,
    if $ambiguous then op_item("scan:linear-identity";"report_linear_identity_ambiguous") else empty end
  ];
def scan_recovered($key;$window;$sourceOK;$targetsOK;$coverage;$ambiguous):
  $sourceOK and $targetsOK and (
    if $key=="scan:source" then true
    elif $key=="scan:dodo-payments" then $window.complete.payments
    elif $key=="scan:dodo-bookings" then $window.complete.bookings
    elif $key=="scan:dodo-records" then $window.complete.records
    elif $key=="scan:items" then $window.complete.items
    elif $key=="scan:targets" then $coverage
    elif $key=="scan:linear-identity" then $ambiguous|not
    else false end);
def plan($window;$issues;$checks;$sourceOK;$targetsOK;$coverage;$run;$at):
  (if $sourceOK then ($window.items + [$checks[].items[]] | ordered_unique) else [] end) as $source |
  (any($issues[];.invalidMetadata) or
    ([$issues[]|.primary]|length) != ([$issues[]|.primary]|unique|length) or
    any($source[]; .key as $key | candidates($issues;$checks;$key) as $claims |
      ($claims|length)>1 or any($claims[];(.verified|not) or .issue.archivedAt!=null or .issue.statusType=="canceled"))) as $ambiguous |
  [$issues[] as $issue | outcome($checks;$issue) as $proof |
    select(($issue.invalidMetadata|not) and ($issue.archivedAt!=null or ($issue|closed)) and $issue.meta.state!="recovered") |
    select(($issue.archivedAt==null and $issue.statusType=="completed" and
      $sourceOK and $targetsOK and ($ambiguous|not) and
      $proof!=null and $proof.state=="unresolved")|not) |
    select(($sourceOK and $targetsOK and
      ([$source[]|.key as $key|select($key==$issue.primary or ($proof!=null and ($proof.keys|index($key)!=null)))]|length)==0 and
      (if $issue.primary|startswith("scan:") then
        scan_recovered($issue.primary;$window;$sourceOK;$targetsOK;$coverage;$ambiguous)
       else $proof!=null and $proof.state=="recovered" end))|not) |
    $issue] as $held |
  ($coverage and ($held|length)==0) as $effectiveCoverage |
  operation_faults($window;$sourceOK;$targetsOK;$effectiveCoverage;$ambiguous) as $ops |
  ($source+$ops|ordered_unique) as $observations |
  [$observations[] as $item | candidates($issues;$checks;$item.key) as $claims |
    {item:$item,claims:$claims,owner:
      (if ($claims|length)==1 and $claims[0].verified then $claims[0].issue.uuid else null end)}] as $groups |
  ([$issues[] as $issue | outcome($checks;$issue) as $proof |
    ([$groups[]|select(.owner==$issue.uuid)|.item] + ($proof.items // []) | ordered_unique) as $negative |
    [$source[]|.key as $key|select($key==$issue.primary or ($proof!=null and ($proof.keys|index($key)!=null)))] as $related |
    (any($groups[];(.claims|length)>1 and any(.claims[];.issue.uuid==$issue.uuid))) as $blocked |
    ($sourceOK and $targetsOK and ($negative|length)==0 and ($related|length)==0 and ($blocked|not) and
      (if $issue.primary|startswith("scan:") then
        scan_recovered($issue.primary;$window;$sourceOK;$targetsOK;$effectiveCoverage;$ambiguous)
       else $proof!=null and $proof.state=="recovered" end)) as $recovered |
    (if ($negative|length)>0 then "unresolved"
     elif $recovered then "recovered"
     elif $proof!=null and $proof.state=="unknown" then "unknown"
     else "incomplete" end) as $state |
    select($issue.archivedAt==null and ($issue.invalidMetadata|not) and
      ((($issue|closed)|not) or ($negative|length)>0 or $proof!=null)) |
    {issue:$issue,primary:$issue.primary,observations:$negative,state:$state,
      keys:(($issue.meta.keys + ($proof.keys // []) + [$negative[].key])|ordered_unique),
      firstSeen:$issue.meta.firstSeen,
      lastSeen:(if ($negative|length)>0 then $at else $issue.meta.lastSeen end),
      lastCheckedAt:(if $proof!=null or ($issue.primary|startswith("scan:")) and $recovered then $at else $issue.meta.lastCheckedAt end),
      changeState:(if $state=="recovered" and (($issue|closed)|not) then "Done"
        elif ($negative|length)>0 and $issue.statusType=="completed" then "Backlog" else null end)}] +
   [$groups[]|select((.claims|length)==0)|.item] | group_by(.key // .primary) |
   map(if .[0].issue? != null then .[] else
     {issue:null,primary:.[0].key,observations:.,state:"unresolved",keys:[.[0].key],
      firstSeen:$at,lastSeen:$at,lastCheckedAt:$at,changeState:null} end)) as $actions |
  ([$actions[]|select(.state=="unknown" or .state=="incomplete")|.primary] + [$held[].primary]|unique|length) as $unknown |
  ($sourceOK and $targetsOK and $effectiveCoverage and ($ambiguous|not) and $unknown==0 and
    $window.complete.payments and $window.complete.bookings and $window.complete.records and $window.complete.items) as $complete |
  {actions:$actions,observations:$observations,ambiguous:$ambiguous,
    metadataInvalid:any($issues[];.invalidMetadata),
    reportedCount:(if $sourceOK then $window.count else 0 end),
    listedCount:(if $sourceOK then $window.items|length else 0 end),
    unknown:$unknown,recovered:([$actions[]|select(.changeState=="Done")]|length),
    open:(([$actions[]|select(.changeState!="Done" and (.issue==null or .changeState=="Backlog" or ((.issue|closed)|not)))]|length)
      + ([$issues[]|select(.archivedAt==null and .invalidMetadata and (closed|not))]|length)),
    complete:$complete,
    result:(if $sourceOK|not then "unavailable" elif $complete|not then "incomplete"
      elif any($actions[];.state=="unresolved") then "mismatch" else "clear" end)};
def comment_body($action;$issue;$run):
  "Payment reconciliation status\nReconciliation: " + ({
    version:1,issueId:$issue.uuid,primary:$action.primary,keys:$action.keys,
    firstSeen:$action.firstSeen,lastSeen:$action.lastSeen,lastCheckedAt:$action.lastCheckedAt,
    state:$action.state,run:$run,observations:$action.observations
  }|tojson);
