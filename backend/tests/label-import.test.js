import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import express from 'express';
import {once} from 'node:events';
import {businessLabelRoutes} from '../src/business-labels.js';

test('Excel preview filters by project across sheets and makes no label writes',async t=>{
  const app=express();
  app.use('/labels',businessLabelRoutes('http://127.0.0.1:1','fixture',()=>({}),(_req,res)=>res.sendStatus(403)));
  const server=app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>server.close());
  const preview=(file,project)=>fetch('http://127.0.0.1:'+server.address().port+'/labels/import-preview?'+new URLSearchParams({project}),{
    method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file
  });
  const book=new ExcelJS.Workbook();
  const first=book.addWorksheet('Orders');
  first.addRows([['Campaigns'],['Project Type','Contact Info'],['SHP (Single Unit)',923324479729],
    [' shp(single unit) ','+92 332 4479729, 923204569689'],['HDHP(Full Share)','923000000001'],
    ['Water Bottles','923000000002'],['SHP(Single Unit)','bad'],['Gaza Food','923000000004']]);
  book.addWorksheet('More').addRows([['Contact Info','Project Type'],['+923000000003','SHP(Single Unit)']]);
  const file=await book.xlsx.writeBuffer();
  const response=await preview(file,'SHP(Single Unit)');
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{numbers:['923324479729','923204569689','923000000003'],matchingRows:4,skipped:1});
  for(const [type,numbers] of [['HDHP(Full Share)',['923000000001']],['Water Bottles',['923000000002']],['Gaza Water Tank Units',[]],['Gaza Food',['923000000004']]]){
    assert.deepEqual((await (await preview(file,type)).json()).numbers,numbers);
  }
  assert.equal((await preview(file,'Other')).status,422);
  assert.equal((await preview('invalid','Water Bottles')).status,422);
  const missing=new ExcelJS.Workbook();
  missing.addWorksheet('Incomplete').addRow(['Contact Info']);
  assert.equal((await preview(await missing.xlsx.writeBuffer(),'Water Bottles')).status,422);
});
