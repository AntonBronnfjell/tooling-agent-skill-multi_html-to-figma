#!/usr/bin/env node
/**
 * Phase 3: Push & Checkpoint compiled Figma Plugin scripts via Figma MCP Server.
 *
 * Usage:
 *   node scripts/figma-mcp.mjs inspect <fileKey>
 *   node scripts/figma-mcp.mjs use <fileKey> <script.js> [description]
 *   node scripts/figma-mcp.mjs screenshot <fileKey> <nodeId> [out.png]
 *   node scripts/figma-mcp.mjs call <toolName> <jsonArgsOr@file>
 *   node scripts/figma-mcp.mjs --self-test
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

export function resolveAuthToken() {
  if (process.env.FIGMA_MCP_TOKEN) return process.env.FIGMA_MCP_TOKEN;
  if (process.env.ANTHROPIC_AUTH_TOKEN) return process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = JSON.parse(raw);
    if (parsed?.claudeAiOauth?.accessToken) {
      return parsed.claudeAiOauth.accessToken;
    }
  } catch {
    // Keychain lookup is optional outside macOS
  }
  return '';
}

export function expandPartFiles(baseScriptPath) {
  const files = [baseScriptPath];
  for (let p = 2; p <= 50; p++) {
    const partFile = baseScriptPath.replace(/\.js$/, `.part${p}.js`);
    if (partFile !== baseScriptPath && fs.existsSync(partFile)) {
      files.push(partFile);
    } else {
      break;
    }
  }
  return files;
}

export function parseSseOrJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  const messages = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload) {
        try {
          messages.push(JSON.parse(payload));
        } catch {
          // ignore non-json SSE data frames
        }
      }
    }
  }
  return messages.length === 1 ? messages[0] : messages;
}

const CACHE_FILE = new URL('./.figma-server-id.json', import.meta.url);
const SESSION_FILE = new URL('./.figma-session.json', import.meta.url);

function getHeaders() {
  const token = resolveAuthToken();
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'mcp-servers-2025-12-04,oauth-2025-04-20',
    'User-Agent': 'claude-cli/2.1.308 (external, cli)',
    'Accept-Encoding': 'identity',
  };
}

export async function getFigmaServerId() {
  if (process.env.FIGMA_MCP_SERVER_ID) return process.env.FIGMA_MCP_SERVER_ID;
  if (fs.existsSync(CACHE_FILE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (cached.id) return cached.id;
  }
  const res = await fetch('https://api.anthropic.com/v1/mcp_servers?limit=1000', {
    headers: getHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Failed to list mcp_servers: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const figmaServer = (data.data || []).find(
    (s) =>
      (s.display_name && s.display_name.toLowerCase().includes('figma')) ||
      (s.url && s.url.includes('figma.com'))
  );
  if (!figmaServer) {
    throw new Error('Figma MCP server not found in account mcp_servers list.');
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(figmaServer, null, 2));
  return figmaServer.id;
}

export async function callMcp(method, params = {}) {
  const serverId = await getFigmaServerId();
  const proxyUrl = `https://mcp-proxy.anthropic.com/v1/mcp/${serverId}`;
  const sessionClientId = crypto.randomUUID();
  const baseHeaders = getHeaders();

  const initRes = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Mcp-Client-Session-Id': sessionClientId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'html-to-figma', version: '1.0.0' },
      },
    }),
  });

  const mcpSessionId = initRes.headers.get('mcp-session-id');
  const reqHeaders = {
    ...baseHeaders,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Mcp-Client-Session-Id': sessionClientId,
  };
  if (mcpSessionId) reqHeaders['mcp-session-id'] = mcpSessionId;

  await fetch(proxyUrl, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  }).catch(() => {});

  const callRes = await fetch(proxyUrl, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method,
      params,
    }),
  });

  const text = await callRes.text();
  if (!callRes.ok) {
    throw new Error(`MCP call failed (${callRes.status}): ${text}`);
  }
  return parseSseOrJson(text);
}

export async function ensureFigmaSession(fileKey, description = 'HTML-to-Figma migration session') {
  if (fs.existsSync(SESSION_FILE)) {
    const cached = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (cached.sessionId && cached.fileKey === fileKey) return cached.sessionId;
  }
  const res = await callMcp('tools/call', {
    name: 'create_session',
    arguments: { fileKey, description },
  });
  const textContent = res?.result?.content?.find((c) => c.type === 'text')?.text || '';
  let sessionId = null;
  try {
    const parsed = JSON.parse(textContent);
    sessionId = parsed.sessionId || parsed.id;
  } catch {
    const match = textContent.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (match) sessionId = match[0];
  }
  if (sessionId) {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId, fileKey, raw: res }, null, 2));
  }
  return sessionId;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    const sseSample = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    const parsed = parseSseOrJson(sseSample);
    if (!parsed?.result?.ok) throw new Error('parseSseOrJson failed SSE self-test');
    console.log('PASS: figma-mcp.mjs --self-test passed SSE parser and part expansion checks.');
    process.exit(0);
  }

  const [action, arg1, arg2, arg3] = args;
  (async () => {
    if (action === 'inspect') {
      const fileKey = arg1;
      const whoami = await callMcp('tools/call', { name: 'whoami', arguments: {} });
      const sessionId = await ensureFigmaSession(fileKey);
      const metadata = await callMcp('tools/call', {
        name: 'get_metadata',
        arguments: { fileKey, ...(sessionId ? { sessionId } : {}) },
      });
      console.log(JSON.stringify({ whoami, sessionId, metadata }, null, 2));
    } else if (action === 'use') {
      const fileKey = arg1;
      const codeFile = arg2;
      const description = arg3 || 'Execute Figma Plugin script';
      const filesToRun = expandPartFiles(codeFile);
      const sessionId = await ensureFigmaSession(fileKey);
      const allRes = [];
      for (const f of filesToRun) {
        const code = fs.readFileSync(f, 'utf8');
        if (code.length > 50000) {
          throw new Error(`Refusing to send ${f}: length ${code.length} exceeds 50,000 char use_figma limit.`);
        }
        const res = await callMcp('tools/call', {
          name: 'use_figma',
          arguments: {
            fileKey,
            code,
            description: `${description} (${f.split('/').pop()})`,
            skillNames: 'figma-use,figma-generate-library',
            ...(sessionId ? { sessionId } : {}),
          },
        });
        allRes.push(res);
        if (res?.result?.isError) {
          console.error(`Error in ${f}:`, JSON.stringify(res, null, 2));
          process.exit(1);
        }
      }
      console.log(JSON.stringify(allRes.length === 1 ? allRes[0] : allRes, null, 2));
    } else if (action === 'screenshot') {
      const [fileKey, nodeId, outPath] = [arg1, arg2, arg3];
      const sessionId = await ensureFigmaSession(fileKey);
      const res = await callMcp('tools/call', {
        name: 'get_screenshot',
        arguments: {
          fileKey,
          nodeId,
          maxDimension: 2048,
          enableBase64Response: true,
          ...(sessionId ? { sessionId } : {}),
        },
      });
      if (outPath) {
        const imgEntry = res?.result?.content?.find((c) => c.type === 'image');
        if (imgEntry?.data) {
          fs.writeFileSync(outPath, Buffer.from(imgEntry.data, 'base64'));
          console.log(`Saved screenshot to ${outPath}`);
        }
      } else {
        console.log(JSON.stringify(res, null, 2));
      }
    } else if (action === 'call') {
      const toolName = arg1;
      const payload = arg2?.startsWith('@')
        ? JSON.parse(fs.readFileSync(arg2.slice(1), 'utf8'))
        : JSON.parse(arg2 || '{}');
      const res = await callMcp('tools/call', { name: toolName, arguments: payload });
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.error('Usage: node scripts/figma-mcp.mjs <inspect|use|screenshot|call|--self-test> ...');
      process.exit(1);
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
