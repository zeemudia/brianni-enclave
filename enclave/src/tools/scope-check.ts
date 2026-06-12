import { TOOL_NAMES, type SkillPack, type ToolName } from '@calypso/chat-types';

const BANNED_TOOL_NAMES = new Set<string>([
  'mailbox.read',
  'calendar.read',
  'email.send',
  'event.create',
  'form.submit',
  'web.automation',
  'browser.use',
  'plaid.connect',
]);

const VALID_TOOL_NAMES = new Set<string>(TOOL_NAMES);

export function isToolBanned(toolName: string): boolean {
  return BANNED_TOOL_NAMES.has(toolName);
}

export function isToolInScope(
  toolName: string,
  pack: Pick<SkillPack, 'toolScopes'>,
): toolName is ToolName {
  if (isToolBanned(toolName)) return false;
  if (!VALID_TOOL_NAMES.has(toolName)) return false;
  return (pack.toolScopes as readonly string[]).includes(toolName);
}
