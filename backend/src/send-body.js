import { validMessageId } from './sent-messages.js';
import { fetchPublicMedia } from './media-fetch.js';

// WAHA send requests are rebuilt from the fields each route needs, instead of
// forwarding the browser's JSON: unknown or unexpected options never reach
// WAHA, and a media link is downloaded by the backend (see media-fetch.js).
const MAX_TEXT=65536;
const chatPattern=/^[\w.:-]{1,64}@(?:c\.us|lid|s\.whatsapp\.net|g\.us|newsletter|broadcast)$/;
const mentionPattern=/^\d{1,20}(?::\d+)?@(?:c\.us|lid|s\.whatsapp\.net)$/;
const base64=/^[A-Za-z0-9+/]*={0,2}$/;
const media=new Set(['sendImage','sendFile','sendVideo','sendVoice']);
const invalid=error=>({status:400,error});
const optionalString=(value,max)=>value===undefined || value===null || (typeof value==='string' && value.length<=max);

export async function wahaSendBody(route,input,{session,restricted}){
  if(!input || typeof input!=='object' || Array.isArray(input))return invalid('Invalid message.');
  const {chatId}=input;
  if(typeof chatId!=='string' || !chatPattern.test(chatId))return invalid('Invalid chat.');
  const body={session,chatId};
  if(input.reply_to!==undefined && input.reply_to!==null){
    const reply=input.reply_to;
    if(!validMessageId(reply))return invalid('Invalid reply.');
    // A regular user may only quote messages from the same chat.
    if(restricted && !reply.startsWith('true_'+chatId+'_') && !reply.startsWith('false_'+chatId+'_'))
      return {status:403,error:'You can only reply to messages in this chat.'};
    body.reply_to=reply;
  }else if(route!=='sendSeen' && route!=='sendVoice')body.reply_to=null;
  if(input.mentions!==undefined && input.mentions!==null){
    if(!Array.isArray(input.mentions) || input.mentions.length>256 || !input.mentions.every(id=>typeof id==='string' && mentionPattern.test(id)))
      return invalid('Invalid mentions.');
    body.mentions=input.mentions;
  }else if(route!=='sendSeen' && route!=='sendVoice')body.mentions=null;
  if(route==='sendSeen'){
    if(input.messageIds!==undefined){
      if(!Array.isArray(input.messageIds) || input.messageIds.length>100 || !input.messageIds.every(validMessageId))return invalid('Invalid messages.');
      body.messageIds=input.messageIds;
    }
    return {body};
  }
  if(route==='sendText'){
    if(typeof input.text!=='string' || !input.text.length || input.text.length>MAX_TEXT)return invalid('Invalid message text.');
    body.text=input.text;
    for(const key of ['linkPreview','linkPreviewHighQuality']){
      if(input[key]===undefined)continue;
      if(typeof input[key]!=='boolean')return invalid('Invalid message options.');
      body[key]=input[key];
    }
    return {body};
  }
  if(!media.has(route))return invalid('Unsupported message type.');
  const file=input.file;
  if(!file || typeof file!=='object' || Array.isArray(file))return invalid('Missing attachment.');
  if(typeof file.mimetype!=='string' || !file.mimetype.trim() || file.mimetype.length>255 || !optionalString(file.filename,255))
    return invalid('Invalid attachment details.');
  const attachment={mimetype:file.mimetype};
  if(typeof file.filename==='string')attachment.filename=file.filename;
  if(typeof file.data==='string' && file.data.length && file.url===undefined){
    if(!base64.test(file.data))return invalid('Invalid attachment data.');
    attachment.data=file.data;
  }else if(typeof file.url==='string' && file.data===undefined){
    try{attachment.data=(await fetchPublicMedia(file.url)).data.toString('base64');}
    catch(err){return {status:err.status||502,error:err.expose?err.message:'Could not download the media link.'};}
  }else return invalid('Attach a file or a media link.');
  body.file=attachment;
  if(route!=='sendVoice'){
    if(!optionalString(input.caption,MAX_TEXT))return invalid('Invalid caption.');
    if(typeof input.caption==='string')body.caption=input.caption;
  }
  if(route==='sendVideo' || route==='sendVoice'){
    if(input.convert!==undefined && typeof input.convert!=='boolean')return invalid('Invalid conversion option.');
    if(input.convert!==undefined)body.convert=input.convert;
  }
  if(route==='sendVideo'){
    if(input.asNote!==undefined && typeof input.asNote!=='boolean')return invalid('Invalid video option.');
    if(input.asNote!==undefined)body.asNote=input.asNote;
  }
  return {body};
}

// Broadcast jobs store their WAHA body, so a media link is downloaded once,
// when the job is accepted, and the job keeps the downloaded data.
export async function resolveBroadcastMedia(input){
  const file=input?.file;
  if(!file || typeof file!=='object' || typeof file.url!=='string')return null;
  try{
    const {data}=await fetchPublicMedia(file.url);
    input.file={filename:file.filename,mimetype:file.mimetype,data:data.toString('base64')};
    return null;
  }catch(err){return {status:err.status||502,error:err.expose?err.message:'Could not download the media link.'};}
}
