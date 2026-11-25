export const isGroupChat = id => /^\d+(?:-\d+)?@g\.us$/.test(id);

export function conversationKey(recipients, contacts) {
  const members = recipients.map(id => contacts.get(id) || id.replace(/@(c\.us|s\.whatsapp\.net)$/, ""));
  return [...new Set(members)].sort().join(",");
}

export function quotedMessageId(message) {
  const id = message.replyTo?.id || message._data?.quotedStanzaID;
  return typeof id === "string" ? id : id?._serialized;
}

// WAHA can return a full serialized ID for the send and only the stanza ID for the quote.
function stanzaId(id) {
  return id.replace(/^(?:true|false)_[^_]+_/, "");
}

export function groupConversations(history, contacts) {
  const threads = new Map();
  const broadcastCopies = new Map();
  const replies = [];
  function add(key, item) {
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key).push(item);
  }
  for (const item of history) {
    const key = item.labelId ? "label:" + item.labelId : conversationKey(item.sender ? [item.sender] : item.recipients || [], contacts);
    if (!key) continue;
    add(key, item);
    if (item.sender) {
      if (item.quotedId) replies.push({member:key, item});
      continue;
    }
    if (!item.labelId && !key.includes(",")) continue;
    for (const result of item.results || []) {
      if (!result.ok || result.ack === -1 || !result.id) continue;
      const member = conversationKey([result.number], contacts);
      if (!broadcastCopies.has(member)) broadcastCopies.set(member,new Map());
      broadcastCopies.get(member).set(stanzaId(result.id),key);
    }
  }
  for (const {member,item} of replies) {
    const broadcast = broadcastCopies.get(member)?.get(stanzaId(item.quotedId));
    if (broadcast) add(broadcast,item);
  }
  // Guard against a missing time: NaN in the comparator leaves items unsorted.
  const time = item => Number.isFinite(item.timestamp) ? item.timestamp : 0;
  for (const items of threads.values()) items.sort((a,b)=>time(a)-time(b));
  return threads;
}
