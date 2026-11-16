// A keyless model for the phone e2e's lab (packages/mobile/e2e). dsh loads it
// as a plugin from the patch layer the harness writes; it must import
// @deepseek-ai/dsh-llm from the dsh install that runs it, so the harness links
// that package next to a copy of this file.
//
// - A prompt containing "slow" streams "tick N" once a second for five
//   minutes: a running reply with nothing pending.
// - A prompt containing "ask me" asks a question (ask_user_question).
// - A prompt containing "say done" replies "done" at once: a finished turn.
// - A prompt containing "liveupdate" streams "tick N" for eight seconds, then asks
//   for approval: a running turn that comes to wait (the Live Update cases).
// - Any other prompt requests an escalated bash call, which waits for approval.
import { LlmAdapter } from "@deepseek-ai/dsh-llm";

/** How many ticks a slow reply streams, one a second. */
const SLOW_TICKS = 300;
/** How many ticks a "live" reply streams before it asks for approval. */
const LIVE_TICKS = 8;

const usage = { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };

function* text(reply) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: reply };
  yield { type: "block-end", index: 0, block: { type: "text", text: reply } };
  yield usage;
  yield { type: "finish", reason: { kind: "stop" } };
}

/** Streams "tick N" once a second for `ticks` seconds as text block `index`. */
async function* ticks(count, signal, index = 0) {
  yield { type: "block-start", index, blockType: "text" };
  let all = "";
  for (let i = 0; i < count; i++) {
    if (signal?.aborted === true) break;
    const piece = `tick ${i} `;
    all += piece;
    yield { type: "text-delta", index, text: piece };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  yield { type: "block-end", index, block: { type: "text", text: all } };
}

async function* slow(signal) {
  yield* ticks(SLOW_TICKS, signal);
  yield usage;
  yield { type: "finish", reason: { kind: "stop" } };
}

function* toolCall(asking, index = 0) {
  const name = asking ? "ask_user_question" : "bash";
  const args = JSON.stringify(
    asking
      ? {
          questions: [
            {
              id: "branch",
              header: "Which branch?",
              question: "Which branch should the lab use?",
              options: [{ label: "main" }, { label: "dev" }],
            },
          ],
        }
      : {
          description: "Prove the approval round trip",
          command: "printf KIVOTOS_APPROVAL_OK",
          sandbox_permissions: "danger-full-access",
          justification: "kivotos phone e2e",
        },
  );
  yield { type: "block-start", index, blockType: "tool-call" };
  yield { type: "tool-call-delta", index, id: "e2e-call", name, argumentsDelta: args };
  yield {
    type: "block-end",
    index,
    block: { type: "tool-call", id: "e2e-call", name, arguments: args },
  };
  yield usage;
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

class E2eMock extends LlmAdapter {
  async listModels(provider) {
    return [{ provider, id: "lab-mock", name: "lab-mock" }];
  }

  async *stream(options) {
    const last = options.messages.at(-1);
    if (last?.role === "tool") {
      const result = last.content
        .filter((block) => block.type === "tool-result")
        .flatMap((block) => block.content)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      yield* text(`tool said: ${result.trim()}`);
      return;
    }
    // dsh appends runtime-context reminders after the prompt, so read every user message.
    const said = JSON.stringify(
      options.messages.filter((message) => message.role === "user").map((m) => m.content),
    );
    if (said.includes("slow")) yield* slow(options.signal);
    else if (said.includes("say done")) yield* text("done");
    else if (said.includes("liveupdate")) {
      yield* ticks(LIVE_TICKS, options.signal);
      yield* toolCall(false, 1);
    } else yield* toolCall(said.includes("ask me"));
  }
}

export const name = "kivotos-e2e-mock-llm";
export const inject = ["llm"];
export function apply(ctx) {
  ctx.llm.registerAdapter(["lab-mock"], new E2eMock());
}
