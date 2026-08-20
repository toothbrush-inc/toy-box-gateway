// Bounded in-memory resumability store. The SDK's example store grows without
// limit; a public endpoint needs a cap per stream.

import type { EventStore } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

interface StoredEvent {
  eventId: string;
  message: JSONRPCMessage;
}

export class BoundedEventStore implements EventStore {
  private readonly streams = new Map<string, StoredEvent[]>();
  private sequence = 0;

  constructor(private readonly maxEventsPerStream: number) {}

  storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    this.sequence += 1;
    const eventId = `${streamId}|${String(this.sequence)}`;
    const events = this.streams.get(streamId) ?? [];
    events.push({ eventId, message });
    if (events.length > this.maxEventsPerStream) {
      events.splice(0, events.length - this.maxEventsPerStream);
    }
    this.streams.set(streamId, events);
    return Promise.resolve(eventId);
  }

  getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    const separator = eventId.lastIndexOf("|");
    return Promise.resolve(separator > 0 ? eventId.slice(0, separator) : undefined);
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    const separator = lastEventId.lastIndexOf("|");
    const streamId = separator > 0 ? lastEventId.slice(0, separator) : "";
    const events = this.streams.get(streamId) ?? [];
    const start = events.findIndex((event) => event.eventId === lastEventId);
    for (const event of events.slice(start === -1 ? 0 : start + 1)) {
      await send(event.eventId, event.message);
    }
    return streamId;
  }
}
