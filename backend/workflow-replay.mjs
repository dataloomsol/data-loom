import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

const call = z.strictObject({
  tool: z.string().min(1).max(100),
  input: z.json()
});

const replayRequest = z.strictObject({
  allowedTools: z.array(z.string().min(1).max(100)).max(100),
  recorded: z.array(z.strictObject({ call, result: z.json() })).min(1).max(100),
  candidate: z.array(call).max(100)
});

export function replayWorkflow(input) {
  const { allowedTools, recorded, candidate } = replayRequest.parse(input);
  const permissions = new Set(allowedTools);
  let matchedCalls = 0;
  for (const [index, step] of candidate.entries()) {
    if (!permissions.has(step.tool)) {
      return { status: 'permission_denied', index, matchedCalls };
    }
    const fixture = recorded[index];
    if (!fixture || !isDeepStrictEqual(step, fixture.call)) {
      return { status: 'unrecorded_call', index, matchedCalls };
    }
    matchedCalls++;
  }
  return {
    status: matchedCalls === recorded.length ? 'matched' : 'ended_early',
    matchedCalls,
    recordedCalls: recorded.length,
    simulatedResults: recorded.slice(0, matchedCalls).map(step => step.result)
  };
}
