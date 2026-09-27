import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('patch_desktop',Path(__file__).resolve().parents[1]/'patch_desktop.py')
patch=importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)

class PatchTests(unittest.TestCase):
    def test_archive_rewrite_preserves_other_files_and_unpacked_metadata(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'input.asar'
            header={'files':{'one':{'size':3,'offset':'0'},'two':{'size':4,'offset':'3'},'native':{'size':4,'unpacked':True}}}
            text=json.dumps(header).encode();payload=struct.pack('<I',len(text))+text;payload+=b'\0'*(-len(payload)%4)
            hp=struct.pack('<I',len(payload))+payload
            path.write_bytes(struct.pack('<II',4,len(hp))+hp+b'oneKEEP')
            archive=patch.Asar(path);out=Path(d)/'output.asar'
            archive.rewrite(out,{'one':b'changed','nested/add':b'NEW'})
            result=patch.Asar(out)
            self.assertEqual(result.read('two'),b'KEEP')
            self.assertEqual(result.read('one'),b'changed')
            self.assertEqual(result.read('nested/add'),b'NEW')
            self.assertEqual(result.entries()['native'],header['files']['native'])
            self.assertEqual(result.entries()['one']['integrity']['hash'],patch.digest(b'changed'))
            self.assertEqual(archive.read('one'),b'one')

    def test_wrong_version_is_rejected_before_staging(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'app.asar';body=b'{"name":"@opencode/desktop","version":"9.9.9"}'
            h={'files':{'package.json':{'size':len(body),'offset':'0'}}};text=json.dumps(h).encode()
            payload=struct.pack('<I',len(text))+text;payload+=b'\0'*(-len(payload)%4);hp=struct.pack('<I',len(payload))+payload
            p.write_bytes(struct.pack('<II',4,len(hp))+hp+body)
            with self.assertRaisesRegex(ValueError,'2.x'):patch.stage(p,Path(d)/'out.asar')
            self.assertFalse((Path(d)/'out.asar').exists())

if __name__=='__main__':unittest.main()
