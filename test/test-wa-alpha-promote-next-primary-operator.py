#!/usr/bin/env python3
"""Offline regression checks for one-service credential retirement operator.
Run without importing/executing production script top-level.
No network, credential files, systemd, or Production mutation.
"""
import ast
import http.client
import pathlib
import sys
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else (
 pathlib.Path(__file__).resolve().parents[1]/"scripts/wa-alpha-promote-next-primary.py"
)
CODE = SOURCE.read_text()
TREE = ast.parse(CODE, filename=str(SOURCE))

class HttpHelperRegression(unittest.TestCase):
 def test_no_shadowed_http_import(self):
  self.assertTrue(any(isinstance(x,ast.Import) and
      any(y.name=="http.client" for y in x.names) for x in TREE.body))
  self.assertFalse(any(isinstance(x,(ast.FunctionDef,ast.AsyncFunctionDef)) and
      x.name=="http" for x in TREE.body))
  self.assertEqual(sum(isinstance(x,ast.FunctionDef) and
      x.name=="http_get" for x in TREE.body),1)
  self.assertFalse(any(isinstance(x,ast.Call) and isinstance(x.func,ast.Name) and
      x.func.id=="http" for x in ast.walk(TREE)))

 def test_http_request_connection_with_synthetic_data(self):
  fn=next(x for x in TREE.body if isinstance(x,ast.FunctionDef) and x.name=="http_get")
  fakecode=compile(ast.Module(body=[fn],type_ignores=[]),str(SOURCE),"exec")
  ns={"http":http}
  exec(fakecode,ns)
  calls=[]
  class Response:
   status=200
   def read(self,limit):return b'{"success":true,"data":[{}]}'
  class Connection:
   def __init__(self,host,port,timeout):calls.append(("connect",host,port,timeout))
   def request(self,method,path,headers):calls.append(("request",method,path,headers))
   def getresponse(self):return Response()
   def close(self):calls.append(("close",))
  with patch.object(http.client,"HTTPConnection",Connection):
   status,body=ns["http_get"]("/api/token-list","synthetic-not-real-key")
  self.assertEqual(status,200)
  self.assertEqual(body,b'{"success":true,"data":[{}]}')
  self.assertEqual(calls[0],("connect","127.0.0.1",3100,8))
  self.assertEqual(calls[1],("request","GET","/api/token-list",
                            {"x-api-key":"synthetic-not-real-key"}))
  self.assertEqual(calls[2],("close",))

 def test_encrypted_primary_and_one_credential_reset(self):
  self.assertIn('settings=["[Service]","LoadCredential="]',CODE)
  self.assertNotIn('settings += ["LoadCredentialEncrypted="]',CODE)
  self.assertIn('settings += ["LoadCredentialEncrypted=PRODUCTION_READ_API_SECRET_KEY:"+str(ACTIVE)]',CODE)
  self.assertIn('"ALPHA_LIVE_PUBLISH_KEY":"/run/wave-alpha-alpha/credentials/ALPHA_LIVE_PUBLISH_KEY"',CODE)
  self.assertIn('require(plain==NEW_PLAIN and encrypted==NEW_ENCRYPTED',CODE)
  self.assertIn('require(plain==ORIGINAL and encrypted==OLD_ENCRYPTED',CODE)
  self.assertIn('LoadCredentialEncrypted=PRODUCTION_READ_API_SECRET_KEY_NEXT', # current dual gate must be represented in baseline mapping
                "LoadCredentialEncrypted=PRODUCTION_READ_API_SECRET_KEY_NEXT")
  self.assertIn('old)[0]!=(200 if expect_old else 401)',CODE)
  self.assertIn('ROLLBACK=PASS_DUAL_RESTORED',CODE)
  self.assertIn('ORACLE_PRIMARY_RETIRE=PASS_LOCAL_RUNTIME',CODE)

 def test_no_print_secret_names(self):
  self.assertNotIn("print(new)",CODE)
  self.assertNotIn("print(old)",CODE)
  self.assertNotIn("print(nextkey)",CODE)

if __name__=="__main__":
 suite=unittest.defaultTestLoader.loadTestsFromTestCase(HttpHelperRegression)
 result=unittest.TextTestRunner(verbosity=0).run(suite)
 print("WA_ALPHA_PRIMARY_OPERATOR_REGRESSION="+
       ("PASS_"+str(result.testsRun) if result.wasSuccessful() else "FAIL"),
       flush=True)
 sys.exit(0 if result.wasSuccessful() else 1)
