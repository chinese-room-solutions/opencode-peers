/**
 * V2 registration of the /peers* commands through ctx.command.transform.
 *
 * Unlike v1 (which had to intercept command.execute.before and rewrite the
 * prompt parts), the v2 command editor offers real execution. The shared
 * logic from src/commands.ts runs, and the result is surfaced inline by
 * prompting the session with the same "show the result verbatim, then stop"
 * phrasing v1's consumeCommand (src/feedback.ts) used.
 */

import type { CommandEditor, CommandInvocation } from "@opencode/plugin/promise/command"
import { errorMessage } from "../feedback.js"
import { handlePeersCommand } from "../commands.js"
import type { QueueInstance } from "../queue.js"
import type { RegistryInstance } from "../registry.js"
import type { OutboxInstance } from "../outbox.js"
import type { V2DeliveryInstance } from "./delivery.js"

/** Structural port of ctx.session.prompt. */
export interface V2PromptSession {
  prompt(input: {
    sessionID: string
    text: string
    metadata?: Record<string, unknown> | null
    delivery?: "steer" | "queue" | null
    [key: string]: unknown
  }): Promise<unknown>
}

export interface V2PeerCommandsOptions {
  session: V2PromptSession
  runtime: {
    noteActivity: (sessionId: string) => Promise<void>
    queueForSession: (sessionId: string) => QueueInstance | null
    deliveryForSession: (sessionId: string) => V2DeliveryInstance | null
    endpointIdForSession: (sessionId: string) => string | null
  }
  registry: RegistryInstance
  outbox: Pick<OutboxInstance, "list">
  getName: () => string
  setName: (name: string) => Promise<{ name: string; changed: boolean }>
  selfInstanceId: string
  /** Fires the sender-side acknowledgement dispatch after inbox mutations. */
  dispatchAcknowledgements: () => Promise<void>
  disposing?: () => boolean
  logger: (level: "info" | "error", message: string, extra?: Record<string, unknown>) => Promise<void>
}

// Mirrors the result phrasing of consumeCommand in src/feedback.ts (kept
// byte-identical there; duplicated because v1 sources are frozen).
function commandResultPrompt(resultMessage: string): string {
  return `This command was already handled by the opencode-peers plugin. Show the following result to the user verbatim, then stop:\n\n${resultMessage}`
}

/** Extract the arguments from whatever prompt text the host hands over. */
export function commandArguments(text: string | undefined): string {
  const trimmed = (text ?? "").trim()
  if (!trimmed.startsWith("/")) return trimmed
  const rest = trimmed.slice(1)
  const space = rest.search(/\s/)
  return space === -1 ? "" : rest.slice(space + 1).trim()
}

export function registerPeerCommands(editor: CommandEditor, deps: V2PeerCommandsOptions): void {
  const definitions: Array<{ name: string; description: string }> = [
    {
      name: "peers",
      description:
        "List same-machine opencode peers you can exchange messages with (cross-session messaging)",
    },
    {
      name: "list-agents",
      description:
        "List same-machine opencode peers you can exchange messages with (alias of /peers, compatible with Claude Code's /list-agents)",
    },
    {
      name: "peers-name",
      description: "Show or set this instance's peer name (used by other sessions to address you)",
    },
    {
      name: "peers-inbox",
      description: "Review held peer messages. Usage: /peers-inbox [accept <n|all> | drop <n|all>]",
    },
    {
      name: "peers-outbox",
      description: "Show transport receipts and final ACK outcomes for messages sent by this session",
    },
  ]

  for (const definition of definitions) {
    editor.add({
      name: definition.name,
      description: definition.description,
      async execute({ sessionID, prompt, delivery }: CommandInvocation) {
        if (deps.disposing?.()) return
        await deps.runtime.noteActivity(sessionID)
        const queue = deps.runtime.queueForSession(sessionID)
        const deliveryInstance = deps.runtime.deliveryForSession(sessionID)

        let message: string
        if (!queue || !deliveryInstance) {
          message = "⏳ opencode-peers is still starting up; try again in a moment."
        } else {
          try {
            const result = await handlePeersCommand(
              {
                registry: deps.registry,
                queue,
                delivery: deliveryInstance,
                getName: deps.getName,
                setName: deps.setName,
                selfInstanceId: deps.selfInstanceId,
                selfEndpointId: deps.runtime.endpointIdForSession(sessionID) ?? deps.selfInstanceId,
                outbox: deps.outbox,
              },
              definition.name,
              commandArguments(prompt?.text)
            )
            message = result.message ?? "✅ Done."
            await deps.dispatchAcknowledgements()
          } catch (err) {
            message = `❌ /${definition.name} failed: ${errorMessage(err)}`
          }
        }

        await deps.session.prompt({
          ...prompt,
          sessionID,
          text: commandResultPrompt(message),
          delivery,
        })
        await deps.logger(message.startsWith("❌") ? "error" : "info", message, {
          command: definition.name,
        })
      },
    })
  }
}
