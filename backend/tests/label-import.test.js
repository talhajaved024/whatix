import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import express from 'express';
import {once} from 'node:events';
import {businessLabelRoutes} from '../src/business-labels.js';
import {internationalNumber,previewLabelWorkbook,NO_PROJECT} from '../src/label-import.js';

test('Excel preview lists the workbook\'s own project types across sheets and makes no label writes',async t=>{
  const app=express();
  app.use('/labels',businessLabelRoutes('http://127.0.0.1:1','fixture',()=>({}),(_req,res)=>res.sendStatus(403)));
  const server=app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>server.close());
  const preview=(file,query={})=>fetch('http://127.0.0.1:'+server.address().port+'/labels/import-preview?'+new URLSearchParams(query),{
    method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file
  });
  const book=new ExcelJS.Workbook();
  const first=book.addWorksheet('Orders');
  first.addRows([['Campaigns'],['Project Type','Contact Info'],['SHP (Single Unit)',923324479729],
    [' shp(single unit) ','+92 332 4479729, 923204569689'],['HDHP(Full Share)','923000000001'],
    ['Water Bottles','923000000002'],['SHP(Single Unit)','bad'],['Solar Panels','923000000004'],['','923000000005'],[]]);
  book.addWorksheet('More').addRows([['Contact Info','Project Type'],['+923000000003','SHP(Single Unit)']]);
  const file=await book.xlsx.writeBuffer();
  const response=await preview(file);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.country,null);
  // Projects come from the file (a type outside any fixed list included),
  // case and spacing variants are one project, blank types are kept last.
  assert.deepEqual(body.projects.map(p=>[p.name,p.rows,p.numbers]),[
    ['HDHP(Full Share)',1,['923000000001']],
    ['SHP(Single Unit)',4,['923324479729','923204569689','923000000003']],
    ['Solar Panels',1,['923000000004']],
    ['Water Bottles',1,['923000000002']],
    [NO_PROJECT,1,['923000000005']]]);
  const shp=body.projects[1];
  assert.deepEqual([shp.skipped,shp.skippedSamples,shp.duplicates,shp.converted],[1,['bad'],1,0]);
  assert.equal((await preview('invalid')).status,422);
  assert.equal((await preview(file,{country:'+92'})).status,422);
  const missing=new ExcelJS.Workbook();
  missing.addWorksheet('Incomplete').addRow(['Contact Info']);
  assert.equal((await preview(await missing.xlsx.writeBuffer())).status,422);
});

test('local Pakistani numbers become +92 instead of being skipped or misread',async()=>{
  const n=(entry,country='92')=>internationalNumber(entry,country)?.number??null;
  assert.equal(n('03001234567'),'923001234567');
  assert.equal(n('0300-1234567'),'923001234567');
  assert.equal(n(3001234567),'923001234567');          // numeric cell: Excel dropped the 0
  assert.equal(n('300 1234567'),'923001234567');
  assert.equal(n('+92 300 1234567'),'923001234567');
  assert.equal(n('923001234567'),'923001234567');
  assert.equal(n('0092 300 1234567'),'923001234567');
  assert.equal(n('+44 20 7946 0000'),'442079460000');   // other countries with + stay as they are
  assert.equal(n('+1 555 123 4567'),'15551234567');
  assert.equal(n('abc'),null);
  assert.equal(n('03001234567',''),null);               // no country code: local numbers cannot be placed
  assert.deepEqual(internationalNumber('03001234567','92'),{number:'923001234567',converted:true});
  const book=new ExcelJS.Workbook();
  book.addWorksheet('Leads').addRows([['Contact Info','Project Type'],['03001234567','Water Bottles'],[3001234568,'water bottles '],
    ['0321-7654321, +923001234567','Water Bottles'],['03451112233','Water Bottle'],['none','Water Bottles'],['none','Water Bottles']]);
  const bytes=Buffer.from(await book.xlsx.writeBuffer());
  const pk=await previewLabelWorkbook(bytes,{country:'92'});
  assert.deepEqual(pk.projects.map(p=>p.name),['Water Bottle','Water Bottles']);
  const bottles=pk.projects[1];
  assert.deepEqual(bottles.numbers,['923001234567','923001234568','923217654321']);
  assert.deepEqual([bottles.rows,bottles.converted,bottles.duplicates,bottles.skipped,bottles.skippedSamples],[5,3,1,2,['none']]);
  assert.deepEqual(pk.projects[0].numbers,['923451112233']);
  const strict=await previewLabelWorkbook(bytes);
  assert.deepEqual(strict.projects[1].numbers,['3001234568','923001234567']);
});
