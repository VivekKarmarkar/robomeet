#!/usr/bin/env node
// A standard MCP client for coding sessions that cannot attach a new server mid-turn.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const [name = 'status', argumentText = '{}'] = process.argv.slice(2);
const client = new Client({ name: 'robomeet-terminal', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./mcp.mjs', import.meta.url))],
  env: { ...process.env },
  stderr: 'inherit',
});
try {
  const args = JSON.parse(argumentText);
  await client.connect(transport);
  const result = name === 'tools' ? await client.listTools() : await client.callTool({ name, arguments: args });
  if (result.isError) process.exitCode = 1;
  for (const part of result.content || []) if (part.type === 'text') process.stdout.write(part.text + '\n');
  if (!result.content) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(`RoboMeet MCP: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await client.close();
}
