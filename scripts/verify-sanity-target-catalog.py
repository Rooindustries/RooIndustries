import argparse,json,re,sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--capture',required=True);p.add_argument('--expected',default='test-results/sanity-sql/catalog-before.json');p.add_argument('--artifact',default='test-results/sanity-sql/target-catalog-compare.json');p.add_argument('--owner-map',action='append',default=[]);p.add_argument('--allow-platform-hook',action='store_true');a=p.parse_args()
expected=json.loads(Path(a.expected).read_text());observed=json.loads(Path(a.capture).read_text());mapping=dict(pair.split('=',1) for pair in a.owner_map)
def normalize(value):
 if isinstance(value,dict):return {k:(mapping.get(v,v) if k=='owner' else normalize(v)) for k,v in value.items()}
 if isinstance(value,list):return [normalize(v) for v in value]
 if isinstance(value,str):
  for owner,target in mapping.items():value=re.sub('/'+re.escape(owner)+r'(?=[,}])','/'+target,value)
 return value
expected=normalize(expected);differences=[]
for kind,key in [('functions','signature'),('tables','table')]:
 old={v[key]:v for v in expected[kind]};new={v[key]:v for v in observed[kind]}
 for name in sorted(set(old)|set(new)):
  if old.get(name)!=new.get(name):
   if a.allow_platform_hook and kind=='functions' and name in ('rls_auto_enable()','public.rls_auto_enable()'):continue
   differences.append({'kind':kind,'name':name,'fields':[f for f in sorted(set(old.get(name,{}))|set(new.get(name,{}))) if old.get(name,{}).get(f)!=new.get(name,{}).get(f)]})
result={'passed':not differences,'expected':a.expected,'capture':a.capture,'ownerMap':mapping,'platformHookException':a.allow_platform_hook,'differences':differences}
artifact=Path(a.artifact);artifact.parent.mkdir(parents=True,exist_ok=True);artifact.write_text(json.dumps(result,indent=2));print(json.dumps({'passed':result['passed'],'artifact':str(artifact),'differences':len(differences)}));sys.exit(0 if result['passed'] else 1)
