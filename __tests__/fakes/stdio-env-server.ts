// Stdio MCP server used by the registry test: reports which env var names the child process sees.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'stdio-env', version: '0.0.0' })
server.registerTool('env_names', { description: 'List env var names' }, async () => ({
  content: [{ type: 'text', text: JSON.stringify(Object.keys(process.env).sort()) }],
}))
process.stderr.write('stdio-env server ready\n')
await server.connect(new StdioServerTransport())
