/**
 * @file src/agent/mcp.js
 * @purpose MCP client connection for external tool servers (e.g., Figma).
 * @exports connectMcp
 * @ai.hint keep
 */

/**
 * Connect to an MCP server and list its tools.
 * @param {{ command: string, args: string[] }} server
 * @returns {Promise<{ tools: object[], call: (name: string, args: object) => Promise<any> }>}
 */
export async function connectMcp(server) {
    try {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        const transport = new StdioClientTransport({ command: server.command, args: server.args ?? [] });
        const client = new Client({ name: 'ai-decompose', version: '0.3.0' });
        await client.connect(transport);
        const { tools } = await client.listTools();
        return {
            tools,
            async call(name, args) {
                const result = await client.callTool({ name, arguments: args });
                return result;
            },
            async close() { await transport.close(); },
        };
    } catch (e) {
        return { tools: [], call: async () => ({ error: e.message }), close: () => {} };
    }
}