// A test page for the relay: publish ops, and list every op the room's log
// delivers with its offset. Open it in two tabs to watch them agree.
import { decodeOp, encodeOp, randomSessionId, randomShapeId, type Op } from "@felix-canvas/model";

import { GatewayClient, type GatewayEvent } from "./gateway.js";

const sid = randomSessionId();
let seq = 0;
let lastOffset: number | null = null;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element<HTMLParagraphElement>("status");
const lastAck = element<HTMLParagraphElement>("last-ack");
const rows = element<HTMLTableSectionElement>("events");

function gatewayUrl(): string {
  const override = new URLSearchParams(location.search).get("gateway");
  if (override) return override;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

function show(event: GatewayEvent): void {
  const row = rows.insertRow();
  let problem: string | undefined;
  if (event.offset !== null && lastOffset !== null) {
    const dropped = event.offset - lastOffset - 1 - event.skippedBefore;
    if (event.offset <= lastOffset) problem = `out of order after ${lastOffset}`;
    else if (dropped > 0) problem = `${dropped} dropped before this`;
  }
  lastOffset = event.offset ?? lastOffset;

  let op: Op | undefined;
  try {
    op = decodeOp(event.payload);
  } catch {
    // Anything can be published to the stream; show it rather than hide it.
  }
  const cells = op
    ? [
        op.sid === sid ? "you" : op.sid.toString(16).padStart(16, "0").slice(0, 8),
        String(op.seq),
        op.kind,
        JSON.stringify(op.fields, (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ]
    : ["", "", "", `not an op (${event.payload.length} bytes)`];
  for (const text of [String(event.offset), ...cells]) {
    row.insertCell().textContent = text;
  }
  if (op?.sid === sid) row.classList.add("mine");
  if (problem) {
    row.classList.add("problem");
    row.title = problem;
  }
  row.scrollIntoView({ block: "nearest" });
}

async function main(): Promise<void> {
  const url = gatewayUrl();
  const client = await GatewayClient.connect(url);
  status.textContent = `Connected to ${url}. Session ${sid.toString(16)}.`;

  client.onEvent = (event) => {
    if (event.stream === "ops") show(event);
  };
  client.onSubscribed = (stream, startOffset) => {
    rows.replaceChildren();
    lastOffset = null;
    status.textContent = `Subscribed to ${stream} from ${startOffset ?? "live"}. Session ${sid.toString(16)}.`;
  };
  client.onError = (error, stream) => {
    status.textContent = `${stream ?? "gateway"}: ${error.code}: ${error.message}`;
  };
  client.onClose = () => {
    status.textContent = "Disconnected from the gateway. Reload to reconnect.";
  };
  client.subscribe("ops", "live");

  element<HTMLFormElement>("publish").addEventListener("submit", async (submit) => {
    submit.preventDefault();
    const label = element<HTMLInputElement>("label");
    const op: Op = {
      sid,
      seq: seq++,
      shape: randomShapeId(),
      kind: "create",
      fields: { type: "rect", label: label.value },
    };
    label.value = "";
    const started = performance.now();
    try {
      const offset = await client.publish("ops", encodeOp(op));
      const elapsed = (performance.now() - started).toFixed(1);
      lastAck.textContent = `seq ${op.seq} acknowledged at offset ${offset} in ${elapsed} ms`;
    } catch (error) {
      lastAck.textContent = `seq ${op.seq} failed: ${String(error)}`;
    }
  });

  element<HTMLFormElement>("resubscribe").addEventListener("submit", (submit) => {
    submit.preventDefault();
    const from = element<HTMLInputElement>("from").value.trim();
    client.subscribe("ops", from === "live" || from === "" ? "live" : Number(from));
  });
}

main().catch((error: unknown) => {
  status.textContent = `Cannot start: ${String(error)}`;
});
