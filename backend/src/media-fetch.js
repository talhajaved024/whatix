import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Media links ("Media link" attachments) are downloaded here, never by WAHA,
// so a link cannot make the server reach internal services (SSRF): only public
// addresses on the standard web ports, checked again after every redirect and
// on the address actually connected to (no DNS rebinding between check and use).
// Separate lists: a BlockList also matches IPv4 addresses against IPv4-mapped
// IPv6 rules, so one shared list holding ::ffff:0:0/96 would block every IPv4.
const blockedV4=new net.BlockList(), blockedV6=new net.BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],
  ['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])blockedV4.addSubnet(address,prefix,'ipv4');
for(const [address,prefix] of [['::',128],['::1',128],['::ffff:0:0',96],['64:ff9b::',96],['100::',64],['2001:db8::',32],
  ['2002::',16],['fc00::',7],['fe80::',10],['ff00::',8]])blockedV6.addSubnet(address,prefix,'ipv6');

export function isPublicAddress(address){
  const family=net.isIP(address);
  if(family===4)return !blockedV4.check(address,'ipv4');
  return family===6 && !blockedV6.check(address,'ipv6');
}

export const MAX_MEDIA_BYTES=37*1024*1024;   // base64 of this stays under WAHA's 50 MiB request limit
const redirects=new Set([301,302,303,307,308]);
const failure=message=>Object.assign(new Error(message),{status:422,expose:true});
const internal=()=>failure('Media links must point to a public website, not a private or internal address.');

function lookup(hostname,options,callback){
  dns.lookup(hostname,{all:true,verbatim:true},(err,addresses)=>{
    if(err)return callback(err);
    if(!addresses.length || addresses.some(entry=>!isPublicAddress(entry.address)))
      return callback(Object.assign(new Error('Blocked address'),{code:'EBLOCKED'}));
    if(options?.all)return callback(null,addresses);
    callback(null,addresses[0].address,addresses[0].family);
  });
}

function request(url,signal){
  return new Promise((resolve,reject)=>{
    const client=url.protocol==='https:'?https:http;
    const req=client.get(url,{agent:false,lookup,signal,headers:{Accept:'*/*','User-Agent':'Mozilla/5.0 (compatible; media-fetch)'}},resolve);
    req.on('error',err=>reject(err.code==='EBLOCKED'?internal():err.name==='AbortError'?failure('The media link took too long to download.'):
      failure('Could not download the media link.')));
  });
}

export async function fetchPublicMedia(raw,{maxBytes=MAX_MEDIA_BYTES,timeoutMs=30000}={}){
  let url;
  try{url=new URL(raw);}catch{throw failure('The media link is not a valid URL.');}
  const signal=AbortSignal.timeout(timeoutMs);
  for(let hop=0;hop<=3;hop++){
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password)throw failure('Media links must be plain http(s) URLs.');
    if(url.port && !['80','443'].includes(url.port))throw failure('Media links must use the standard web ports.');
    const host=url.hostname.replace(/^\[|\]$/g,'');
    if(net.isIP(host) && !isPublicAddress(host))throw internal();
    const response=await request(url,signal);
    if(redirects.has(response.statusCode) && response.headers.location){
      response.resume();
      try{url=new URL(response.headers.location,url);}catch{throw failure('The media link redirected to an invalid URL.');}
      continue;
    }
    if(response.statusCode!==200){response.resume();throw failure('The media link returned HTTP '+response.statusCode+'.');}
    if(Number(response.headers['content-length'])>maxBytes){response.destroy();throw failure('The linked file is too large to send.');}
    const chunks=[];let size=0;
    try{
      for await(const chunk of response){
        size+=chunk.length;
        if(size>maxBytes){response.destroy();throw failure('The linked file is too large to send.');}
        chunks.push(chunk);
      }
    }catch(err){throw err.expose?err:failure('Could not download the media link.');}
    if(!size)throw failure('The media link returned an empty file.');
    return {data:Buffer.concat(chunks),contentType:String(response.headers['content-type']||'')};
  }
  throw failure('The media link redirected too many times.');
}
