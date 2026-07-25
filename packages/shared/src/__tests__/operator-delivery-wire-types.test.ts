import { describe, expect, it } from "vitest";
import type {
  AgentOperatorDelivery,
  EventForwardMessage,
  FailedOperatorDelivery,
  OperatorDelivery,
  OperatorDeliveryPresentation,
  ReadyOperatorDelivery,
} from "../protocol.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<Value extends true> = Value;

type ExpectedReady = {
  version: 1;
  sourceSha256: string;
  status: "ready";
  text: string;
  checks: { plain: true; anchorsPreserved: true };
};
type ExpectedFailed = {
  version: 1;
  sourceSha256: string;
  status: "failed";
  code: "provider-unavailable" | "timed-out" | "provider-error" | "invalid-rewrite";
};
type ExpectedAgent = {
  version: 1;
  sourceSha256: string;
  status: "agent";
};
type ExpectedPresentation = {
  version: 1;
  deliverySha256: string;
  text: string;
};

type _ReadyContractIsExact = Assert<Equal<ReadyOperatorDelivery, ExpectedReady>>;
type _FailedContractIsExact = Assert<Equal<FailedOperatorDelivery, ExpectedFailed>>;
type _AgentContractIsExact = Assert<Equal<AgentOperatorDelivery, ExpectedAgent>>;
type _DeliveryUnionIsExact = Assert<Equal<OperatorDelivery, ExpectedReady | ExpectedFailed | ExpectedAgent>>;
type _PresentationContractIsExact = Assert<Equal<OperatorDeliveryPresentation, ExpectedPresentation>>;

const ready = {
  version: 1,
  sourceSha256: "a".repeat(64),
  status: "ready",
  text: "Keep the release undeployed.",
  checks: { plain: true, anchorsPreserved: true },
} satisfies ReadyOperatorDelivery;

const presentation = {
  version: 1,
  deliverySha256: "b".repeat(64),
  text: "Keep the release undeployed. ![chart](pi-asset:0123456789abcdef)",
} satisfies OperatorDeliveryPresentation;

const frame = {
  type: "event_forward",
  sessionId: "typed-delivery",
  event: {
    eventType: "message_end",
    timestamp: 1,
    data: {
      message: {
        role: "assistant",
        content: "internal source",
        operatorDelivery: ready,
        operatorDeliveryPresentation: presentation,
      },
    },
  },
} satisfies EventForwardMessage;

// These directives are compile-time regression checks: if the wire contract
// becomes porous, TypeScript reports the now-unused expected error.
// @ts-expect-error `provider-timeout` is not a producer failure code.
const wrongFailure: FailedOperatorDelivery = { version: 1, sourceSha256: "a".repeat(64), status: "failed", code: "provider-timeout" };
// @ts-expect-error A ready delivery cannot omit its exact checks proof.
const missingChecks: ReadyOperatorDelivery = { version: 1, sourceSha256: "a".repeat(64), status: "ready", text: "Plain." };
// @ts-expect-error The sidecar binds `deliverySha256`, not a source digest.
const wrongPresentation: OperatorDeliveryPresentation = { version: 1, sourceSha256: "b".repeat(64), text: "Plain." };

describe("operator-delivery wire types", () => {
  it("carry the typed delivery and presentation through event_forward", () => {
    expect(frame.event.data.message?.operatorDelivery).toEqual(ready);
    expect(frame.event.data.message?.operatorDeliveryPresentation).toEqual(presentation);
  });
});
