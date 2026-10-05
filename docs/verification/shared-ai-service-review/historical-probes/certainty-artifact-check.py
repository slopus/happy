from pathlib import Path
import json,tarfile,hashlib,base64
P=Path('/Users/jacky/jacky-github/happy--shared-ai-services');A=Path('/Users/jacky/jacky-github/relationship-advisor--paws-services')
for name in ['paws-agent-0.3.0','paws-connect-ui-0.1.0']:
 fname='wangjs-jacky-'+name+'.tgz';pkg='@wangjs-jacky/'+name.rsplit('-',1)[0];contents=[]
 for root,vendor in [(P/'examples/ai-service-smoke','vendor'),(A,'vendor/paws')]:
  path=root/vendor/fname;data=path.read_bytes();contents.append(data)
  integrity='sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()
  assert json.loads((root/'package-lock.json').read_text())['packages']['node_modules/'+pkg]['integrity']==integrity
  with tarfile.open(path) as tar:
   files=[f for f in tar.getmembers() if f.isfile()]
   for file in files:
    assert tar.extractfile(file).read()==(root/'node_modules'/pkg/file.name.removeprefix('package/')).read_bytes(),file.name
  print(json.dumps({'consumer':str(root),'artifact':fname,'files':len(files),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'installedFiles':'identical','lockIntegrity':'matches'}))
 assert contents[0]==contents[1]
