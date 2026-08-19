import { describe, expect, it } from "vitest";
import {
  evaluateClaimEntailment,
  type CandidateClaimEvaluation,
  type SourceClaim,
} from "../translator-claim-entailment.js";

function claim(category: SourceClaim["category"], question: string, answer: string): SourceClaim {
  return { id: "c1", category, question, answer };
}

function evaluated(answer: string, evaluatorInstructionDetected = false): CandidateClaimEvaluation {
  return { evaluatorInstructionDetected, answers: [{ id: "c1", answer }] };
}

describe("claim-level entailment gate", () => {
  it.each([
    {
      control: "changed quantity",
      source: [claim("quantity", "How many records remain?", "587 records")],
      candidate: evaluated("578 records"),
    },
    {
      control: "flipped negation",
      source: [claim("negation", "Is deployment enabled?", "deployment is not enabled")],
      candidate: evaluated("deployment is enabled"),
    },
    {
      control: "changed actor or attribution",
      source: [claim("actor-attribution", "Who approved the release?", "Lane approved the release")],
      candidate: evaluated("Joan approved the release"),
    },
    {
      control: "softened blocker force",
      source: [claim("blocker", "What is the work status?", "the work is blocked")],
      candidate: evaluated("the work is delayed"),
    },
    {
      control: "dropped decision",
      source: [claim("decision", "Was deployment refused?", "deployment was refused")],
      candidate: { evaluatorInstructionDetected: false, answers: [] },
    },
    {
      control: "instruction aimed at the evaluator",
      source: [claim("decision", "Was deployment refused?", "deployment was refused")],
      candidate: evaluated("deployment was refused", true),
    },
  ])("rejects $control", ({ source, candidate }) => {
    expect(evaluateClaimEntailment(source, candidate).pass).toBe(false);
  });

  it.each([
    {
      control: "identical claims",
      source: [claim("actor-attribution", "Who approved the release?", "Lane approved the release")],
      candidate: evaluated("Lane approved the release"),
    },
    {
      control: "duration wording",
      source: [claim("quantity", "How long did the run take?", "5h 22m")],
      candidate: evaluated("5 hours and 22 minutes"),
    },
    {
      control: "zero and none with identical scope",
      source: [claim("negation", "How many deployment approvals exist?", "zero deployment approvals")],
      candidate: evaluated("none of the deployment approvals exist"),
    },
  ])("accepts $control", ({ source, candidate }) => {
    expect(evaluateClaimEntailment(source, candidate).pass).toBe(true);
  });
});
