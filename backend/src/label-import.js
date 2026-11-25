import ExcelJS from 'exceljs';

const projects=['SHP(Single Unit)','Water Bottles','HDHP(Full Share)','Gaza Water Tank Units','Gaza Food'];
const normalize=value=>String(value??'').trim().toLowerCase().replace(/\s+/g,' ').replace(/\s*([()])\s*/g,'$1');
const invalid=message=>Object.assign(new Error(message),{status:422});

function cellText(cell){
  const value=cell.value;
  if(value && typeof value==='object'){
    if(Array.isArray(value.richText))return value.richText.map(run=>run.text).join('');
    return String(value.result ?? value.text ?? '');
  }
  return String(value??'');
}

export async function previewLabelWorkbook(bytes,project){
  if(!projects.includes(project))throw invalid('Choose a project type from the list.');
  const workbook=new ExcelJS.Workbook();
  try{await workbook.xlsx.load(bytes);}
  catch{throw invalid('Could not read this workbook. Upload an Excel .xlsx file.');}
  const numbers=new Set();
  let foundHeaders=false,matchingRows=0,skipped=0;
  for(const sheet of workbook.worksheets){
    let contactColumn,projectColumn;
    sheet.eachRow(row=>{
      if(!contactColumn){
        const columns=new Map();
        row.eachCell((cell,index)=>columns.set(normalize(cellText(cell)),index));
        if(columns.has('contact info') && columns.has('project type')){
          contactColumn=columns.get('contact info');
          projectColumn=columns.get('project type');
          foundHeaders=true;
        }
        return;
      }
      if(normalize(cellText(row.getCell(projectColumn)))!==normalize(project))return;
      matchingRows++;
      // A cell can contain multiple contacts separated by punctuation or a line break.
      for(const token of cellText(row.getCell(contactColumn)).trim().split(/\s*[,;/|\r\n]+\s*/)){
        const number=token.replace(/[\s()-]/g,'').replace(/^\+/,'');
        if(/^[1-9]\d{6,14}$/.test(number))numbers.add(number);
        else skipped++;
      }
    });
  }
  if(!foundHeaders)throw invalid('The workbook needs Contact Info and Project Type headers on the same row.');
  return {numbers:[...numbers],matchingRows,skipped};
}
