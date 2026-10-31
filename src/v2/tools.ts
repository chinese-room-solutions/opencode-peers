/**
 * V2 registration of the peer tools through ctx.tool.transform, using the
 * shared execute handlers from src/tools/handlers.ts. zod 4's
 * z.toJSONSchema() converts the exact schemas the v1 entry uses into the
 * JSON Schema the v2 tool editor expects.
 *
 * Every tool opts out of Code Mode (`codemode: false`) so the model invokes
 * it directly as a tool call, matching the v1 host.
 */

import type { ToolEditor, ToolContext } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import {
  createPeerToolHandlers,
  LIST_AGENTS_DESCRIPTION,
  listAgentsSchema,
  PEER_MESSAGE_STATUS_DESCRIPTION,
  peerMessageStatusSchema,
  sendMessageSchema,
  SEND_MESSAGE_DESCRIPTION,
  type ToolsDeps,
} from "../tools/handlers.js"

export function registerPeerTools(editor: ToolEditor, deps: ToolsDeps): void {
  const handlers = createPeerToolHandlers(deps)

  editor.add({
    name: "peer_message_status",
    options: { codemode: false },
    description: PEER_MESSAGE_STATUS_DESCRIPTION,
    input: z.toJSONSchema(peerMessageStatusSchema),
    async execute(args, context: ToolContext) {
      const content = await handlers.peerMessageStatus(
        args as { message_id: string },
        context
      )
      return { content }
    },
  })

  editor.add({
    name: "list_agents",
    options: { codemode: false },
    description: LIST_AGENTS_DESCRIPTION,
    input: z.toJSONSchema(listAgentsSchema),
    async execute(args, context: ToolContext) {
      const content = await handlers.listAgents(
        args as { include_offline?: boolean; project_only?: boolean; directory?: string },
        context
      )
      return { content }
    },
  })

  editor.add({
    name: "send_message",
    options: { codemode: false },
    description: SEND_MESSAGE_DESCRIPTION,
    input: z.toJSONSchema(sendMessageSchema),
    async execute(args, context: ToolContext) {
      const content = await handlers.sendMessage(args as { to: string; message: string }, context)
      return { content }
    },
  })
}
