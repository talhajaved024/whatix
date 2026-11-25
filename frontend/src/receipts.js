export function receipt(message) {
  const id = typeof message?.id === "string" ? message.id : message?.id?._serialized;
  const stages = { ERROR: -1, PENDING: 0, SERVER: 1, DEVICE: 2, READ: 3, PLAYED: 4 };
  const ack = stages[message?.ackName] ?? message?.ack;
  return { id, ack: Number.isInteger(ack) && ack >= -1 && ack <= 4 ? ack : undefined };
}

export function mergeAck(previous, next) {
  if (next == null) return previous;
  if (previous == null) return next;
  if (next === -1) return previous >= 2 ? previous : -1;
  if (previous === -1 && next === 0) return previous;
  return Math.max(previous, next);
}
