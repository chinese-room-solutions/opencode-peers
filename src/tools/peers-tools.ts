/**
 * LLM-callable tools:
 *   - list_agents:  discover same-machine opencode peers
 *   - send_message: send a plain-text message to a peer
 *
 * The execute logic lives in ./handlers.ts and is shared verbatim with the
 * OpenCode v2 plugin entry (src/v2/tools.ts); this module only wraps it in
 * @opencode-ai/plugin's tool() definition shape.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import {
  createPeerToolHandlers,
  LIST_AGENTS_DESCRIPTION,
  listAgentsArgs,
  PEER_MESSAGE_STATUS_DESCRIPTION,
  peerMessageStatusArgs,
  sendMessageArgs,
  SEND_MESSAGE_DESCRIPTION,
} from "./handlers.js"

export type { ToolsDeps, ToolContextLike } from "./handlers.js"
export { entryId, formatPeerList } from "./handlers.js"
export {
  createPeerToolHandlers,
  isEndpointShaped,
  LIST_AGENTS_DESCRIPTION,
  listAgentsArgs,
  listAgentsSchema,
  PEER_MESSAGE_STATUS_DESCRIPTION,
  peerMessageStatusArgs,
  peerMessageStatusSchema,
  sendMessageArgs,
  sendMessageSchema,
  SEND_MESSAGE_DESCRIPTION,
} from "./handlers.js"

export function buildPeerTools(deps: Parameters<typeof createPeerToolHandlers>[0]): Record<string, ToolDefinition> {
  const handlers = createPeerToolHandlers(deps)
  return {
    peer_message_status: tool({
      description: PEER_MESSAGE_STATUS_DESCRIPTION,
      args: peerMessageStatusArgs,
      execute: (args, context) => handlers.peerMessageStatus(args, context),
    }),

    list_agents: tool({
      description: LIST_AGENTS_DESCRIPTION,
      args: listAgentsArgs,
      execute: (args, context) => handlers.listAgents(args, context),
    }),

    send_message: tool({
      description: SEND_MESSAGE_DESCRIPTION,
      args: sendMessageArgs,
      execute: (args, context) => handlers.sendMessage(args, context),
    }),
  }
}
