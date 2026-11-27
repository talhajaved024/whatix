import ExcelJS from 'exceljs';

// Case and spacing differences ("water bottles ", "Water Bottles") are one
// project; any other difference ("Water Bottle") is a separate project.
const normalize=value=>String(value??'').trim().toLowerCase().replace(/\s+/g,' ').replace(/\s*([()])\s*/g,'$1');
const invalid=message=>Object.assign(new Error(message),{status:422});
const SAMPLES=5;
export const NO_PROJECT='(No project type)';

function cellText(cell){
  const value=cell.value;
  if(value && typeof value==='object'){
    if(Array.isArray(value.richText))return value.richText.map(run=>run.text).join('');
    return String(value.result ?? value.text ?? '');
  }
  return String(value??'');
}

// One contact entry as an international number (digits, no +), or null.
// Spreadsheets hold numbers in local form: "0300 1234567", or 3001234567 once
// Excel has dropped the leading 0 from a numeric cell. `country` (e.g. "92")
// turns those into +92 300 1234567 instead of misreading them (3001234567
// would otherwise be a +30 Greek number). An entry starting with + or 00, or
// already starting with the country code, is taken as international as is.
export function internationalNumber(entry,country=''){
  const text=String(entry??'').trim();
  let digits=text.replace(/\D/g,'');
  if(!digits)return null;
  let converted=false;
  if(text.startsWith('+'))digits=digits.replace(/^0+/,'');
  else if(digits.startsWith('00'))digits=digits.slice(2);
  else if(digits.startsWith('0')){
    if(!country)return null;
    digits=country+digits.replace(/^0+/,'');converted=true;
  }else if(country && !digits.startsWith(country) && digits.length<=10){
    digits=country+digits;converted=true;
  }
  return /^[1-9]\d{6,14}$/.test(digits)?{number:digits,converted}:null;
}

// Every Project Type in the workbook with its numbers, read once. The admin
// then picks one of the workbook's own project types; nothing is written.
export async function previewLabelWorkbook(bytes,{country=''}={}){
  if(country && !/^[1-9]\d{0,3}$/.test(country))throw invalid('Enter a country code of 1 to 4 digits, like 92.');
  const workbook=new ExcelJS.Workbook();
  try{await workbook.xlsx.load(bytes);}
  catch{throw invalid('Could not read this workbook. Upload an Excel .xlsx file.');}
  const groups=new Map(); // normalized project -> group
  let foundHeaders=false;
  function group(text){
    const key=normalize(text);
    if(!groups.has(key))groups.set(key,{spellings:new Map(),rows:0,numbers:new Set(),skipped:0,skippedSamples:[],converted:0,duplicates:0});
    const entry=groups.get(key),name=text.trim().replace(/\s+/g,' ')||NO_PROJECT;
    entry.spellings.set(name,(entry.spellings.get(name)||0)+1);
    return entry;
  }
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
      const contacts=cellText(row.getCell(contactColumn)).trim();
      const project=cellText(row.getCell(projectColumn));
      if(!contacts && !project.trim())return; // blank row
      const entry=group(project);
      entry.rows++;
      // A cell can contain multiple contacts separated by punctuation or a line break.
      for(const token of contacts.split(/\s*[,;/|\r\n]+\s*/)){
        if(!token)continue;
        const result=internationalNumber(token,country);
        if(!result){
          entry.skipped++;
          const sample=token.slice(0,40);
          if(entry.skippedSamples.length<SAMPLES && !entry.skippedSamples.includes(sample))entry.skippedSamples.push(sample);
          continue;
        }
        if(entry.numbers.has(result.number)){entry.duplicates++;continue;}
        entry.numbers.add(result.number);
        if(result.converted)entry.converted++;
      }
    });
  }
  if(!foundHeaders)throw invalid('The workbook needs Contact Info and Project Type headers on the same row.');
  const projects=[...groups.values()].map(({spellings,numbers,...stats})=>({
    // The spelling used most often names the project.
    name:[...spellings].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0],
    ...stats,numbers:[...numbers]
  })).sort((a,b)=>(a.name===NO_PROJECT)-(b.name===NO_PROJECT)||a.name.localeCompare(b.name));
  return {country:country||null,projects};
}
